import { updateRequestSchema } from "@homelab/contracts/updates";
import type { SQL } from "bun";
import * as v from "valibot";

import { enqueueJob, lockQueue } from "../../jobs/queue";
import type { JobHandler } from "../../jobs/types";
import { OperationFailure } from "../../operations/errors";
import type { ApplicationTarget } from "../applications/configuration";
import { applyUpdate, updateTimeoutMs } from "./apply";
import { updateBatchJobs } from "./batch";
import { updateTargetRevision, type UpdateTarget } from "./configuration";
import { executeUpdate, type UpdateExecutor } from "./execution";
import { readUpdateReport, staleUpdateReport } from "./inventory";
import { readUpdatePolicies } from "./policies";
import { updateReceiptScope, updateReceiptResourceKeys } from "./receipts";
import { matchesUpdateTarget, updateControl } from "./selection";

const payloadSchema = v.strictObject({
    ...v.omit(updateRequestSchema, ["requestId"]).entries,
    automatic: v.boolean(),
    policyVersion: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

/**
 * Register separately authorized installers and a policy-gated automatic admission job.
 * @param targets - Deployment-owned update recipes; an empty list enables no installer.
 * @param client - Dashboard state, never an application database.
 * @param execute - Worker-only SSH boundary; tests inject isolated execution fixtures.
 * @param applications - Explicit source bindings used only for verified identity reconciliation.
 * @returns Jobs sharing the existing queue, resource leases, progress and notifications.
 */
export function updateActionJobs(
    targets: readonly UpdateTarget[],
    client: SQL,
    execute: UpdateExecutor = executeUpdate,
    applications: readonly ApplicationTarget[] = []
): readonly JobHandler[] {
    if (targets.length === 0) return [];
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
                    !["patch", "minor"].includes(control.change)
                )
                    throw new Error("Automatic update permission changed");
            }
            await context.reportProgress(
                `Preparing the approved update for ${item.name}.`
            );
            await applyUpdate(
                target,
                item,
                input.automatic,
                context,
                execute,
                updateReceiptScope(target, targets, applications)
            );
        },
    }));
    return [
        ...installers,
        ...updateBatchJobs(targets, client, execute, applications),
        {
            definition: {
                key: "updates.automatic",
                label: "Schedule automatic updates",
                description:
                    "Queue patch and minor updates only for explicitly enabled targets; never upgrade majors or reboot hosts.",
                resourceClass: "network",
                capability: "updates:configure",
                resourceKeys: ["updates:admission"],
                timeoutMs: 60_000,
                attemptLimit: 1,
                retrySafe: true,
                intervalSeconds: 3600,
                validate: (input) => v.parse(v.strictObject({}), input),
            },
            execute: async (_input, context) => {
                const policies = await readUpdatePolicies(client, targets);
                let queued = 0;
                for (const target of targets) {
                    context.signal.throwIfAborted();
                    const policy = policies.find(
                        (candidate) => candidate.target === target.id
                    );
                    if (!policy?.enabled) continue;
                    const report = await readUpdateReport(client, target.source);
                    const installer = installers.find(
                        (candidate) =>
                            candidate.definition.key === `updates.install.${target.id}`
                    );
                    if (!report || staleUpdateReport(report) || !installer) continue;
                    for (const item of report.items) {
                        if (queued >= 50) return;
                        if (!matchesUpdateTarget(target, item)) continue;
                        const control = updateControl(target, report, item);
                        if (
                            !control.allowed ||
                            !["patch", "minor"].includes(control.change)
                        )
                            continue;
                        const candidateKey = new Bun.CryptoHasher("sha256")
                            .update(
                                JSON.stringify([
                                    updateTargetRevision(target),
                                    item.id,
                                    item.available,
                                    item.availableImage,
                                ])
                            )
                            .digest("hex");
                        if (
                            !(await context.commit(async (transaction) => {
                                // Failed/expired automatic runs are not silently retried for the same candidate.
                                const key = `automatic-update:${target.id}:${candidateKey}`;
                                const [existing] = await transaction<
                                    { id: string }[]
                                >`SELECT id FROM job_runs WHERE idempotency_key=${key}`;
                                if (existing) return;
                                const [active] = await transaction<
                                    { id: string }[]
                                >`SELECT id FROM job_runs WHERE action=${installer.definition.key} AND state IN ('queued','running') LIMIT 1`;
                                if (active) return;
                                await enqueueJob(
                                    transaction,
                                    installer.definition,
                                    "system:automatic-updates",
                                    key,
                                    {
                                        target: target.id,
                                        item: item.id,
                                        revision: control.revision,
                                        automatic: true,
                                        policyVersion: policy.version,
                                    },
                                    `Update ${item.name}`
                                );
                                queued += 1;
                            }, true))
                        )
                            throw new Error("Automatic update admission lost its claim");
                    }
                }
                await context.reportProgress(
                    `Queued ${queued} eligible automatic updates.`
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
