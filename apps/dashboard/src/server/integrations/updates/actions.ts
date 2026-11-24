import {
    type UpdateControl,
    type UpdatePolicy,
    updateRequestSchema,
    type UpdateSource,
} from "@homelab/contracts/updates";
import type { SQL } from "bun";
import * as v from "valibot";

import { enqueueJob, lockQueue } from "../../jobs/queue";
import type { JobHandler } from "../../jobs/types";
import { OperationFailure } from "../../operations/errors";
import type { ApplicationTarget } from "../applications/configuration";
import { applyUpdate, updateTimeoutMs } from "./apply";
import { updateBatchJobs } from "./batch";
import { type UpdateTarget, updateTargetRevision } from "./configuration";
import { executeUpdate, type UpdateExecutor } from "./execution";
import { freshAptObservation, readUpdateReport } from "./inventory";
import { readUpdatePolicies } from "./policies";
import {
    updateReceiptResourceKeys,
    updateReceiptScope,
    verifyUpdateReceiptLeases,
} from "./receipts";
import { matchesUpdateTarget, updateControl } from "./selection";

const payloadSchema = v.strictObject({
    ...v.omit(updateRequestSchema, ["requestId"]).entries,
    automatic: v.boolean(),
    policyVersion: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

function automaticReason(
    policy: UpdatePolicy | undefined,
    control: UpdateControl
): string | null {
    if (!policy?.enabled) return "automatic updates off";
    if (!control.allowed) return control.reason ?? "installation unavailable";
    switch (control.change) {
        case "digest": {
            return policy.allowDigest ? null : "digest-only updates off";
        }
        case "major": {
            return "major upgrade";
        }
        case "unknown": {
            return "versions cannot be safely compared";
        }
        default: {
            return null;
        }
    }
}

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
            await applyUpdate(
                target,
                item,
                input.automatic && control.change === "digest"
                    ? "digest"
                    : input.automatic,
                context,
                execute,
                receiptScope,
                refresh?.definition
            );
        },
    }));
    return [
        ...installers,
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
                let policies = await readUpdatePolicies(client, targets);
                if (refresh && policies.some((policy) => policy.enabled)) {
                    await refresh.execute({}, context);
                    policies = await readUpdatePolicies(client, targets);
                }
                let queued = 0;
                let available = 0;
                const examples: string[] = [];
                const skip = (name: string, reason: string) => {
                    if (examples.length < 4)
                        examples.push(
                            `${name.replaceAll(/\p{Cc}/gu, " ").slice(0, 55)}: ${reason}`
                        );
                };
                const sourceIds = new Set([
                    ...targets.map((target) => target.source),
                    ...sources.map((source) => source.id),
                ]);
                for (const source of sourceIds) {
                    context.signal.throwIfAborted();
                    const report = await readUpdateReport(client, source);
                    if (!report) continue;
                    const sourceTargets = targets.filter(
                        (target) => target.source === source
                    );
                    for (const item of report.items) {
                        if (item.status !== "available") continue;
                        available++;
                        const target = sourceTargets.find((candidate) =>
                            matchesUpdateTarget(candidate, item)
                        );
                        if (!target) {
                            skip(item.name, "no configured installer");
                            continue;
                        }
                        const policy = policies.find(
                            (candidate) => candidate.target === target.id
                        );
                        const control = updateControl(target, report, item);
                        const reason =
                            automaticReason(policy, control) ??
                            (target.driver.kind === "apt" && !freshAptObservation(report)
                                ? "package observation expired"
                                : null) ??
                            (queued >= 50 ? "queue limit reached" : null);
                        if (reason || !policy) {
                            skip(item.name, reason ?? "automatic updates off");
                            continue;
                        }
                        const installer = installers.find(
                            (candidate) =>
                                candidate.definition.key ===
                                `updates.install.${target.id}`
                        )!;
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
                                // Serialize admission with operator policy writes so a
                                // disable committed during checking cannot enqueue work.
                                const [currentPolicy] = await transaction<
                                    {
                                        enabled: boolean;
                                        version: number;
                                        configuration: string;
                                    }[]
                                >`SELECT enabled,version,configuration FROM update_policies WHERE target=${target.id} FOR SHARE`;
                                if (
                                    !currentPolicy?.enabled ||
                                    currentPolicy.version !== policy.version ||
                                    currentPolicy.configuration !==
                                        updateTargetRevision(target)
                                ) {
                                    skip(item.name, "policy changed");
                                    return;
                                }
                                // Failed/expired automatic runs are not silently retried for the same candidate.
                                const key = `automatic-update:${target.id}:${candidateKey}`;
                                const [existing] = await transaction<
                                    { id: string }[]
                                >`SELECT id FROM job_runs WHERE idempotency_key=${key}`;
                                if (existing) {
                                    skip(item.name, "already attempted");
                                    return;
                                }
                                const [active] = await transaction<
                                    { id: string }[]
                                >`SELECT id FROM job_runs WHERE action=${installer.definition.key} AND state IN ('queued','running') LIMIT 1`;
                                if (active) {
                                    skip(
                                        item.name,
                                        "another installation is queued or running"
                                    );
                                    return;
                                }
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
                const skipped = available - queued;
                const summary = `${available} available · ${queued} queued · ${skipped} skipped`;
                await context.reportProgress(
                    [
                        summary,
                        ...examples,
                        ...(skipped > examples.length
                            ? [`and ${skipped - examples.length} more`]
                            : []),
                    ]
                        .join(" · ")
                        .slice(0, 500)
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
