import { updateRequestSchema, type UpdateSource } from "@homelab/contracts/updates";
import type { SQL } from "bun";
import * as v from "valibot";

import { enqueueJob, lockQueue } from "../../jobs/queue";
import type { JobHandler } from "../../jobs/types";
import { OperationFailure } from "../../operations/errors";
import type { ApplicationTarget } from "../applications/configuration";
import { applyUpdate, updateTimeoutMs } from "./apply";
import { admitAutomaticUpdates, automaticReason } from "./automaticAdmission";
import { updateBatchJobs } from "./batch";
import type { UpdateTarget } from "./configuration";
import { executeUpdate, type UpdateExecutor } from "./execution";
import { freshAptObservation, readUpdateReport } from "./inventory";
import { readUpdatePolicies } from "./policies";
import {
    updateReceiptResourceKeys,
    updateReceiptScope,
    verifyUpdateReceiptLeases,
} from "./receipts";
import { updateControl } from "./selection";

const payloadSchema = v.strictObject({
    ...v.omit(updateRequestSchema, ["requestId"]).entries,
    automatic: v.boolean(),
    policyVersion: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

const continuationSchema = v.strictObject({
    source: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    parent: v.pipe(v.string(), v.uuid()),
});

/**
 * Register separately authorized installers and a policy-gated automatic admission job.
 * @param targets - Deployment-owned update recipes; an empty list enables no installer.
 * @param client - Dashboard state, never an application database.
 * @param execute - Worker-only SSH boundary; tests inject isolated execution fixtures.
 * @param applications - Explicit source bindings used only for verified identity reconciliation.
 * @param refresh - Shared read-only inventory checker run before automatic admission.
 * @param sources - Additional configured publishers whose observations may have no installer.
 * @returns Jobs sharing the existing queue, resource leases, progress and notifications.
 */
export function updateActionJobs(
    targets: readonly UpdateTarget[],
    client: SQL,
    execute: UpdateExecutor = executeUpdate,
    applications: readonly ApplicationTarget[] = [],
    refresh?: JobHandler,
    sources: readonly UpdateSource[] = []
): readonly JobHandler[] {
    if (targets.length === 0) return [];
    const continuation: JobHandler | undefined = refresh && {
        definition: {
            ...refresh.definition,
            key: "updates.apt-continue",
            label: "Check remaining automatic package updates",
            description:
                "Refresh one host's package inventory and admit the next eligible update under its original policy.",
            admission: "integration",
            capability: "updates:configure",
            intervalSeconds: null,
            resourceKeys: ["updates:admission", ...refresh.definition.resourceKeys],
            validate: (input) => v.parse(continuationSchema, input),
        },
        execute: async (payload, context) => {
            const { source, parent } = v.parse(continuationSchema, payload);
            // The refresh is also required after interrupted or partially applied installs.
            await refresh.execute({ source, purpose: "prepare" }, context);
            const [prior] = await client<{ target: string; version: number }[]>`
                SELECT payload->>'target' AS target, (payload->>'policyVersion')::int AS version
                FROM job_runs WHERE id=${parent} AND state='succeeded' AND NOT cancel_requested
                AND requested_by='system:automatic-updates' AND payload->>'automatic'='true'
                AND action='updates.install.' || (payload->>'target')`;
            const target = targets.find(
                (entry) =>
                    entry.id === prior?.target &&
                    entry.source === source &&
                    entry.driver.kind === "apt"
            );
            if (target && prior?.version)
                await admitAutomaticUpdates(
                    client,
                    context,
                    [target],
                    [source],
                    installers,
                    prior.version
                );
        },
    };
    const installers: JobHandler[] = targets.map((target) => ({
        definition: {
            key: `updates.install.${target.id}`,
            label: `Update ${target.label}`,
            description:
                "Install an explicitly approved version and verify the result without rebooting the host.",
            resourceClass: "interactive",
            capability: "updates:apply",
            resourceKeys: updateReceiptResourceKeys(
                updateReceiptScope(target, targets, applications)
            ),
            timeoutMs: updateTimeoutMs,
            attemptLimit: 1,
            retrySafe: false,
            intervalSeconds: null,
            admission: "integration",
            validate: (input) => v.parse(payloadSchema, input),
        },
        execute: async (value, context) => {
            const input = v.parse(payloadSchema, value);
            const [run] = await client<
                { fresh: boolean }[]
            >`SELECT created_at >= now() - interval '5 minutes' AS fresh FROM job_runs WHERE id=${context.runId}`;
            if (!run?.fresh || input.target !== target.id)
                throw new Error("Update authorization expired");
            const receiptScope = updateReceiptScope(target, targets, applications);
            await verifyUpdateReceiptLeases(client, context.runId, [receiptScope]);
            const report = await readUpdateReport(client, target.source);
            const item = report?.items.find((candidate) => candidate.id === input.item);
            if (!report || !item) throw new Error("Update observation is unavailable");
            const control = updateControl(target, report, item);
            if (!control.allowed || control.revision !== input.revision)
                throw new Error("Update versions or configuration changed");
            if (input.automatic) {
                const [policy] = await readUpdatePolicies(client, [target]);
                if (
                    !policy?.enabled ||
                    policy.version !== input.policyVersion ||
                    automaticReason(policy, control)
                )
                    throw new Error("Automatic update permission changed");
            }
            await context.reportProgress(
                `Preparing the approved update for ${item.name}.`
            );
            const morePackages =
                input.automatic &&
                target.driver.kind === "apt" &&
                report.items.some(
                    (other) =>
                        other.kind === "os" &&
                        other.id !== item.id &&
                        other.status === "available"
                );
            const followUp =
                morePackages && continuation
                    ? {
                          definition: continuation.definition,
                          payload: { source: target.source, parent: context.runId },
                      }
                    : refresh && {
                          definition: refresh.definition,
                          payload: { source: target.source },
                      };
            await applyUpdate(
                target,
                item,
                input.automatic && control.change === "digest"
                    ? "digest"
                    : input.automatic,
                context,
                execute,
                receiptScope,
                followUp
            );
        },
    }));
    return [
        ...installers,
        ...(continuation ? [continuation] : []),
        ...updateBatchJobs(targets, client, execute, applications, refresh?.definition),
        {
            definition: {
                key: "updates.automatic",
                label: "Schedule automatic updates",
                description:
                    "Queue verified updates under each target's automatic update policy.",
                resourceClass: "network",
                capability: "updates:configure",
                resourceKeys: [
                    "updates:admission",
                    ...(refresh?.definition.resourceKeys ?? []),
                ],
                timeoutMs: 60_000 + (refresh?.definition.timeoutMs ?? 0),
                attemptLimit: 1,
                retrySafe: true,
                intervalSeconds: 3600,
                validate: (input) => v.parse(v.strictObject({}), input),
            },
            execute: async (_input, context) => {
                const policies = await readUpdatePolicies(client, targets);
                if (refresh && policies.some((policy) => policy.enabled))
                    await refresh.execute({}, context);
                const sourceIds = new Set([
                    ...targets.map((target) => target.source),
                    ...sources.map((source) => source.id),
                ]);
                await admitAutomaticUpdates(
                    client,
                    context,
                    targets,
                    sourceIds,
                    installers
                );
            },
        },
    ];
}

/**
 * Admit one manually confirmed observation through the same integration-only installer.
 * @param client - Operational database.
 * @param target - Configured target selected by an authorized caller.
 * @param handler - Matching registered installer.
 * @param actor - Caller identity used for audit and replay isolation.
 * @param input - Browser-safe item identity, revision and request ID.
 * @returns Existing or newly queued job ID.
 */
export async function requestUpdate(
    client: SQL,
    target: UpdateTarget,
    handler: JobHandler,
    actor: string,
    input: v.InferOutput<typeof updateRequestSchema>
): Promise<{ id: string }> {
    return client.begin(async (transaction) => {
        await lockQueue(transaction);
        const key = `${actor}:update:${input.requestId}`;
        const [existing] = await transaction<
            { id: string }[]
        >`SELECT id FROM job_runs WHERE idempotency_key=${key}`;
        const report = await readUpdateReport(transaction, target.source);
        const item = report?.items.find((candidate) => candidate.id === input.item);
        if (!existing) {
            if (!report || !item)
                throw new OperationFailure(
                    "NOT_FOUND",
                    "The software observation is no longer available."
                );
            if (target.driver.kind === "apt" && !freshAptObservation(report))
                throw new OperationFailure(
                    "PRECONDITION_FAILED",
                    "Refresh the current package status and review the update before installing."
                );
            const control = updateControl(target, report, item);
            if (!control.allowed)
                throw new OperationFailure(
                    "PRECONDITION_FAILED",
                    control.reason ?? "The update is unavailable."
                );
            if (input.target !== target.id || control.revision !== input.revision)
                throw new OperationFailure(
                    "CONFLICT",
                    "The update changed. Refresh and confirm the current version."
                );
        }
        const { requestId: _request, ...payload } = input;
        return {
            id: await enqueueJob(
                transaction,
                handler.definition,
                actor,
                key,
                { ...payload, automatic: false },
                `Update ${item?.name ?? target.label}`
            ),
        };
    });
}
