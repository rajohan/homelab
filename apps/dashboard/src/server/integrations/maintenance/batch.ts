import type { SQL, TransactionSQL } from "bun";

import { publishNotification } from "../../notifications/publish";
import { auditOperation } from "../../operations/audit";
import { OperationFailure } from "../../operations/errors";
import { restartObservationTime } from "../updates/restartObservation";
import type { FleetEntry } from "./dispatch";

type StepState = "waiting" | "running" | "done" | "skipped" | "failed";
export type RestartStep = {
    host: string;
    hostLabel: string;
    unit: string;
    label: string;
    bootId: string;
    invocationId: string | null;
    target?: string;
    configuration?: string;
    state: StepState;
    child?: string;
    channel?: "job" | "controller";
    checkedAfter: number;
    waitingSince?: number;
    reason?: string;
};
export type RestartBatch = {
    id: string;
    actor: string;
    requested: number;
    phase: "waiting" | "running" | "complete" | "attention";
    requestHash?: string;
    parent?: string;
    steps: RestartStep[];
};
const prefix = "maintenance.batch:";

/** Persist an admitted batch or its fenced progress in the caller's transaction.
 * @param tx - Queue admission or receipt transaction.
 * @param batch - Durable operation and its service-specific evidence.
 */
export async function saveRestartBatch(tx: TransactionSQL, batch: RestartBatch) {
    await tx`INSERT INTO operation_snapshots(key,value,captured_at) VALUES(${prefix + batch.id},${JSON.stringify(batch)}::text::jsonb,clock_timestamp())
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,captured_at=excluded.captured_at`;
}

/** Stage only services implicated by a verified update; the coordinator waits for the parent to finish.
 * @param tx - Fenced successful update receipt transaction holding the queue lock.
 * @param input - Server-observed host, boot and affected service invocation IDs.
 */
export async function queueUpdateRestarts(
    tx: TransactionSQL,
    input: {
        runId: string;
        connection: string;
        host: string;
        bootId: string;
        services: readonly { unit: string; invocationId: string | null }[];
    }
) {
    if (input.services.length === 0) return;
    const [existing] = await tx<
        { value: RestartBatch }[]
    >`SELECT value FROM operation_snapshots WHERE key=${prefix + input.runId} FOR UPDATE`;
    const now = Date.parse(await restartObservationTime(tx));
    const batch: RestartBatch = existing?.value ?? {
        id: input.runId,
        parent: input.runId,
        actor: "system:updates",
        requested: now,
        phase: "waiting",
        steps: [],
    };
    if (batch.parent !== input.runId || batch.phase !== "waiting")
        throw new Error("Unexpected post-update restart batch state.");
    for (const service of input.services) {
        const prior = batch.steps.find(
            (step) => step.host === input.host && step.unit === service.unit
        );
        const step: RestartStep = {
            host: input.host,
            hostLabel: input.connection,
            unit: service.unit,
            label: service.unit,
            bootId: input.bootId,
            invocationId: service.invocationId,
            checkedAfter: now,
            state: "waiting",
        };
        if (prior) Object.assign(prior, step);
        else batch.steps.push(step);
    }
    await saveRestartBatch(tx, batch);
}

/** Freeze a human-reviewed set of actionable services; hosts always need their own confirmation.
 * @param tx - Locked admission transaction.
 * @param actor - Verified operator.
 * @param input - Request identity and displayed target revisions.
 * @param entries - Server-observed fleet rows.
 * @param hosts - Connection identities mapped to canonical SSH hosts.
 * @returns Stable batch ID, including on an identical retry.
 */
export async function admitRestartBatch(
    tx: TransactionSQL,
    actor: string,
    input: {
        requestId: string;
        targets: readonly { target: string; revision: string }[];
    },
    entries: readonly FleetEntry[],
    hosts: ReadonlyMap<string, string>
) {
    const reviewed = new Map(input.targets.map((item) => [item.target, item.revision]));
    const requestHash = new Bun.CryptoHasher("sha256")
        .update(
            JSON.stringify(
                [...reviewed].toSorted(([left], [right]) => left.localeCompare(right))
            )
        )
        .digest("hex");
    const [previous] = await tx<
        { value: RestartBatch }[]
    >`SELECT value FROM operation_snapshots WHERE key=${prefix + input.requestId}`;
    if (previous) {
        if (previous.value.actor !== actor || previous.value.requestHash !== requestHash)
            throw new OperationFailure(
                "CONFLICT",
                "The request ID belongs to a different operation."
            );
        return { id: input.requestId };
    }
    const required = entries.filter(
        (entry) =>
            entry.plan.kind === "service" && entry.plan.required && entry.plan.allowed
    );
    if (
        required.length === 0 ||
        required.length !== reviewed.size ||
        reviewed.size !== input.targets.length ||
        required.some(
            (entry) =>
                reviewed.get(entry.target.id) !== entry.plan.revision ||
                !entry.observation?.invocationId ||
                !entry.target.service ||
                !hosts.has(entry.target.connection)
        )
    )
        throw new OperationFailure(
            "CONFLICT",
            "The required services changed. Review the current list before restarting."
        );
    const [active] = await tx<
        { key: string }[]
    >`SELECT key FROM operation_snapshots WHERE key LIKE 'maintenance.batch:%' AND value->>'phase' IN ('waiting','running') AND NOT (value ? 'parent') LIMIT 1`;
    if (active)
        throw new OperationFailure(
            "CONFLICT",
            "A confirmed restart batch is already in progress."
        );
    const batch: RestartBatch = {
        id: input.requestId,
        actor,
        requested: Date.now(),
        phase: "waiting",
        requestHash,
        steps: required.map(({ target, observation, configuration, plan }) => ({
            target: target.id,
            configuration,
            host: hosts.get(target.connection)!,
            hostLabel: plan.host.label,
            unit: observation!.canonicalUnit ?? target.service!,
            label: target.label,
            bootId: observation!.bootId,
            invocationId: observation!.invocationId,
            state: "waiting",
            checkedAfter: 0,
        })),
    };
    await saveRestartBatch(tx, batch);
    await auditOperation(tx, actor, "maintenance.batch_requested", batch.id);
    return { id: batch.id };
}

/** Finish reconciled batches and alert the operator when manual follow-up remains.
 * @param tx - Transaction owning this batch's progress.
 * @param batch - Batch after processing its latest step.
 */
export async function finishRestartBatch(tx: TransactionSQL, batch: RestartBatch) {
    if (batch.steps.some((step) => step.state === "waiting" || step.state === "running"))
        return;
    const failures = batch.steps.filter((step) => step.state === "failed");
    batch.phase = failures.length > 0 ? "attention" : "complete";
    if (failures.length > 0)
        await publishNotification(tx, "maintenance", {
            key: `restart-batch:${batch.id}`,
            title: "Service restarts need attention",
            message: failures
                .slice(0, 3)
                .map(
                    (step) =>
                        `${step.hostLabel} · ${step.label}: ${step.reason ?? "Review restart status."}`
                )
                .join(" · ")
                .slice(0, 490),
            severity: "warning",
            destination: "jobs",
        });
}

/** Read the current batch, or the most recently finished batch, for the Restarts panel.
 * @param client - Dashboard connection.
 * @returns Counts excluding individual host restarts, or null before the first batch.
 */
export async function restartBatchStatus(client: SQL) {
    const [row] = await client<
        { value: RestartBatch }[]
    >`SELECT value FROM operation_snapshots WHERE key LIKE 'maintenance.batch:%'
        ORDER BY (value->>'phase'='running') DESC,(value->>'phase'='waiting') DESC,captured_at DESC LIMIT 1`;
    if (!row) return null;
    const { id, steps, phase } = row.value;
    const followUp = steps
        .filter((step) => step.state === "failed")
        .map((step) => ({
            target: new Bun.CryptoHasher("sha256")
                .update(JSON.stringify([step.host, step.unit]))
                .digest("hex"),
            label: `${step.hostLabel} · ${step.label}`,
            reason: step.reason ?? "Review restart status.",
        }));
    return {
        id,
        phase,
        total: steps.length,
        completed: steps.filter((s) => s.state === "done").length,
        skipped: steps.filter((s) => s.state === "skipped").length,
        failed: followUp.length,
        followUp,
        pending: steps.filter((s) => s.state === "waiting").length,
        active: steps.find((s) => s.state === "running")?.label ?? null,
    };
}
