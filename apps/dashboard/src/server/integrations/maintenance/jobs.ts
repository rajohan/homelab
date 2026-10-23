import { maintenanceRequestSchema } from "@homelab/contracts/maintenance";
import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import { updateResourceKeys, type UpdateTarget } from "../updates/configuration";
import {
    recordRestartObservation,
    restartObservationTime,
} from "../updates/restartObservation";
import { maintenanceRevision, type MaintenanceTarget } from "./configuration";
import {
    observationSchema,
    probeMaintenance,
    type MaintenanceObservation,
    type MaintenanceProbe,
} from "./execution";

const payloadSchema = v.strictObject({
    target: maintenanceRequestSchema.entries.target,
    configuration: maintenanceRequestSchema.entries.revision,
    revision: maintenanceRequestSchema.entries.revision,
    expected: observationSchema,
});

/**
 * Read one recent successful observation, bound to the current restart authority.
 * @param client - Dashboard database or queue-admission transaction.
 * @param target - Reviewed restart target.
 * @param connection - Existing scoped update connection.
 * @returns A safe confirmation plan and private execution evidence, or an unavailable plan.
 */
export async function maintenancePlan(
    client: SQL | TransactionSQL,
    target: MaintenanceTarget,
    connection: UpdateTarget
) {
    const [row] = await client<
        {
            value: { configuration: string; observation: MaintenanceObservation | null };
            capturedAt: string;
            fresh: boolean;
        }[]
    >`SELECT value, captured_at::text AS "capturedAt", captured_at > now() - interval '2 minutes' AS fresh FROM operation_snapshots WHERE key = ${`maintenance:${target.id}`}`;
    const configuration = maintenanceRevision(target, connection);
    const observation =
        row?.value.configuration === configuration ? row.value.observation : null;
    const revision = new Bun.CryptoHasher("sha256")
        .update(
            JSON.stringify({ configuration, observation, capturedAt: row?.capturedAt })
        )
        .digest("hex");
    const allowed = Boolean(
        row?.fresh &&
        observation &&
        (target.kind === "host" || observation.active === "active")
    );
    return {
        target: target.id,
        label: target.label,
        impact: target.impact,
        kind: target.kind,
        revision,
        configuration,
        observation,
        capturedAt: row?.capturedAt ?? null,
        allowed,
        reason: allowed
            ? null
            : "Refresh the restart status. A stopped or unavailable service cannot be restarted here.",
    };
}

async function wait(signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const done = () => {
            signal.removeEventListener("abort", abort);
            resolve();
        };
        const timer = setTimeout(done, 2000);
        const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(new Error("Maintenance verification cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });
}

/**
 * Register read-only status jobs and separate, human-confirmed restart jobs.
 * @param targets - Explicitly qualified worker-independent restart recipes.
 * @param connections - Existing SSH authorities; no new trust or credentials are inferred.
 * @param probe - Fixed remote boundary, replaced by synthetic tests.
 * @returns Jobs sharing update host leases; mutation jobs never retry or run on a schedule.
 */
export function maintenanceJobs(
    targets: readonly MaintenanceTarget[],
    connections: readonly UpdateTarget[],
    probe: MaintenanceProbe = probeMaintenance
): JobHandler[] {
    return targets.flatMap((target): JobHandler[] => {
        const connection = connections.find((entry) => entry.id === target.connection)!;
        const configuration = maintenanceRevision(target, connection);
        return [
            {
                definition: {
                    key: `maintenance.inspect.${target.id}`,
                    label: `Check restart status: ${target.label}`,
                    description:
                        "Read restart requirements and service state without changing the host.",
                    resourceClass: "network",
                    capability: "updates:refresh",
                    resourceKeys: [
                        `snapshot:maintenance:${target.id}`,
                        ...updateResourceKeys(connection),
                    ],
                    timeoutMs: 45_000,
                    attemptLimit: 1,
                    retrySafe: true,
                    intervalSeconds: 60,
                    validate: (input) => v.parse(v.strictObject({}), input),
                },
                execute: async (_payload, context) => {
                    await context.reportProgress(
                        "Checking the configured service and restart requirements."
                    );
                    let observation: MaintenanceObservation | null = null;
                    try {
                        observation = await probe(
                            connection,
                            target,
                            "inspect",
                            context.signal
                        );
                    } catch {
                        context.signal.throwIfAborted();
                    }
                    if (
                        !(await context.commit(async (transaction) => {
                            await transaction`INSERT INTO operation_snapshots (key, value, captured_at) VALUES (${`maintenance:${target.id}`}, ${JSON.stringify({ configuration, observation })}::text::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at`;
                        }))
                    )
                        throw new Error("Maintenance status ownership changed");
                    if (!observation)
                        throw new Error("Maintenance status is unavailable");
                },
            },
            {
                definition: {
                    key: `maintenance.restart.${target.id}`,
                    label: `Restart ${target.label}`,
                    description: target.impact,
                    resourceClass: "interactive",
                    capability: "maintenance:restart",
                    resourceKeys: updateResourceKeys(connection),
                    timeoutMs: target.kind === "host" ? 600_000 : 360_000,
                    attemptLimit: 1,
                    retrySafe: false,
                    intervalSeconds: null,
                    admission: "integration",
                    validate: (input) => v.parse(payloadSchema, input),
                },
                execute: async (value, context) => {
                    const input = v.parse(payloadSchema, value);
                    if (
                        input.target !== target.id ||
                        input.configuration !== configuration
                    )
                        throw new Error("Restart confirmation expired or changed");
                    const authorize = async () => {
                        if (
                            !(await context.commit(async (transaction) => {
                                const [request] = await transaction<
                                    { fresh: boolean }[]
                                >`SELECT created_at >= clock_timestamp() - interval '5 minutes' AS fresh FROM job_runs WHERE id = ${context.runId}`;
                                if (!request?.fresh)
                                    throw new Error("Restart confirmation expired");
                            }))
                        )
                            throw new Error("Restart ownership changed");
                    };
                    await authorize();
                    const before = await probe(
                        connection,
                        target,
                        "inspect",
                        context.signal
                    );
                    if (
                        before.bootId !== input.expected.bootId ||
                        before.active !== input.expected.active
                    )
                        throw new Error("Restart target changed since confirmation");
                    context.signal.throwIfAborted();
                    await authorize();
                    await context.reportProgress(
                        target.kind === "host"
                            ? "Requesting the confirmed host restart. This request cannot be undone once accepted."
                            : "Restarting the confirmed service."
                    );
                    let after: MaintenanceObservation | undefined;
                    try {
                        after = await probe(
                            connection,
                            target,
                            "restart",
                            context.signal,
                            input.expected
                        );
                    } catch {
                        context.signal.throwIfAborted();
                        if (target.kind === "service")
                            throw new Error(
                                "Service restart could not be verified; inspect before retrying"
                            );
                    }
                    if (target.kind === "host") {
                        await context.reportProgress(
                            "Waiting for the host to return with a new boot identity and pass its health check."
                        );
                        after = undefined;
                        while (!after) {
                            await wait(context.signal);
                            try {
                                const current = await probe(
                                    connection,
                                    target,
                                    "verify",
                                    AbortSignal.any([
                                        context.signal,
                                        AbortSignal.timeout(40_000),
                                    ])
                                );
                                if (current.bootId !== before.bootId && current.health)
                                    after = current;
                            } catch {
                                context.signal.throwIfAborted();
                            }
                        }
                    }
                    if (!after?.health)
                        throw new Error("Restart health verification failed");
                    const result = {
                        label: target.label,
                        operation:
                            target.kind === "host" ? "host-restart" : "service-restart",
                        installed: null,
                        health: "passed",
                        rebootRequired: after.rebootRequired,
                        warnings: after.serviceRestartRequired
                            ? [
                                  "The service is still reported as requiring a restart; inspect its dependencies.",
                              ]
                            : [],
                    };
                    if (
                        !(await context.commit(async (transaction) => {
                            await transaction`UPDATE job_runs SET results = ${JSON.stringify([result])}::text::jsonb WHERE id = ${context.runId}`;
                            await recordRestartObservation(
                                transaction,
                                connection.source,
                                connections.some(
                                    (other) =>
                                        other.source === connection.source &&
                                        other.host.toLowerCase() !==
                                            connection.host.toLowerCase()
                                )
                                    ? null
                                    : after.rebootRequired,
                                await restartObservationTime(transaction)
                            );
                            await transaction`DELETE FROM operation_snapshots WHERE key = ${`maintenance:${target.id}`}`;
                        }))
                    )
                        throw new Error("Restart result ownership changed");
                    await context.reportProgress(
                        "Restart completed and health verified."
                    );
                },
            },
        ];
    });
}
