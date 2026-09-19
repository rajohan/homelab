import {
    applicationIntentSchema,
    type ApplicationInventory,
} from "@homelab/contracts/applications";
import type { SQL } from "bun";
import * as v from "valibot";

import { applicationClientEnvironment } from "../../config/environment";
import type { JobHandler } from "../../jobs/types";
import { publishNotification } from "../../notifications/publish";
import { performApplicationAction } from "./actions";
import type { ApplicationTarget } from "./configuration";
import { createDockerPort, type DockerPort } from "./docker";
import { collectApplications } from "./inventory";
import { readApplicationInventory } from "./selection";

const payloadSchema = v.omit(applicationIntentSchema, ["requestId"]);

function persist(
    inventory: ApplicationInventory,
    context: Parameters<JobHandler["execute"]>[1]
) {
    return context.commit(async (transaction) => {
        const previous = await readApplicationInventory(transaction);
        for (const host of inventory.hosts) {
            const before = previous?.hosts.find((item) => item.id === host.id);
            if (before?.available === host.available || (!before && host.available))
                continue;
            await publishNotification(transaction, "applications", {
                key: `${host.id}:${host.available ? "up" : "down"}:${inventory.capturedAt}`,
                title: `${host.label}: applications ${host.available ? "available" : "unavailable"}`,
                message: host.available
                    ? "The worker can read this host again. Application controls are available."
                    : "The worker could not refresh this host. Application actions are disabled until it recovers.",
                severity: host.available ? "success" : "warning",
                destination: "applications",
            });
        }
        await transaction`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('applications.inventory',${JSON.stringify(inventory)}::text::jsonb,${new Date(inventory.capturedAt)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,captured_at=EXCLUDED.captured_at`;
    });
}

/**
 * Register worker discovery and integration-only lifecycle actions for configured Docker hosts.
 * @param targets - Explicit host allowlists, without credential values.
 * @param client - Dashboard database used to bound queued authorization lifetime.
 * @param connect - Worker-only transport factory; tests inject isolated fixtures.
 * @returns Registered jobs, with unsafe external effects disabled for automatic retries.
 */
export function applicationJobs(
    targets: readonly ApplicationTarget[],
    client: SQL,
    connect: (target: ApplicationTarget) => DockerPort = (target) =>
        createDockerPort(target, applicationClientEnvironment(target))
): readonly JobHandler[] {
    if (targets.length === 0) return [];
    return [
        {
            definition: {
                key: "applications.discover",
                label: "Refresh application inventory",
                description:
                    "Read safe metadata for allowlisted applications without changing their state.",
                resourceClass: "network",
                capability: "applications:read",
                resourceKeys: ["applications:inventory"],
                timeoutMs: 60_000,
                attemptLimit: 3,
                retrySafe: true,
                intervalSeconds: 60,
                validate: (input) => v.parse(v.strictObject({}), input),
            },
            execute: async (_input, context) => {
                await context.reportProgress(
                    "Reading application inventory from the configured hosts."
                );
                const inventory = await collectApplications(
                    targets,
                    connect,
                    context.signal,
                    await readApplicationInventory(client)
                );
                if (!(await persist(inventory, context)))
                    throw new Error("Application snapshot ownership changed");
            },
        },
        ...(["start", "stop", "restart"] as const).map((operation) => ({
            definition: {
                key: `applications.${operation}`,
                label: `${operation[0]?.toUpperCase()}${operation.slice(1)} applications`,
                description:
                    "Apply an explicitly confirmed lifecycle operation to the exact observed application selection.",
                resourceClass: "interactive" as const,
                capability: `applications:${operation}` as const,
                resourceKeys: ["applications:inventory"],
                timeoutMs: 300_000,
                attemptLimit: 1,
                retrySafe: false,
                intervalSeconds: null,
                admission: "integration" as const,
                validate: (input: unknown) => v.parse(payloadSchema, input),
            },
            execute: async (
                input: Record<string, unknown>,
                context: Parameters<JobHandler["execute"]>[1]
            ) => {
                const intent = v.parse(payloadSchema, input);
                const target = targets.find((item) => item.id === intent.host);
                const [run] = await client<
                    { created_at: Date }[]
                >`SELECT created_at FROM job_runs WHERE id=${context.runId}`;
                if (
                    !target ||
                    intent.operation !== operation ||
                    !run ||
                    Date.now() - run.created_at.getTime() > 120_000
                )
                    throw new Error(
                        "Application authorization expired or target changed"
                    );
                context.signal.throwIfAborted();
                if (!(await context.commit(async () => {})))
                    throw new Error("Application action no longer owns its job");
                let persisted = true;
                try {
                    await performApplicationAction(
                        target,
                        connect(target),
                        intent,
                        context.signal,
                        context.reportProgress
                    );
                    await context.reportProgress(
                        "Refreshing application status after the operation."
                    );
                } finally {
                    // Failed health checks can leave changed container states too.
                    // Cancellation loses the write fence; scheduled discovery handles it later.
                    if (!context.signal.aborted) {
                        const inventory = await collectApplications(
                            targets,
                            connect,
                            context.signal,
                            await readApplicationInventory(client)
                        );
                        persisted = await persist(inventory, context);
                    }
                }
                if (!persisted) throw new Error("Application result ownership changed");
            },
        })),
    ];
}
