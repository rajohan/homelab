import type { SQL, TransactionSQL } from "bun";

import { queueMessage } from "../../jobs/queueMessage";
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
    notStarted?: boolean;
    channel?: "job" | "controller";
    resourceKeys?: readonly string[] | undefined;
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
 * @param id - Optional exact batch to inspect from activity history.
 * @param actor - Owner of the selected batch or the update that staged it.
 * @returns Counts excluding individual host restarts, or null when unavailable.
 */
export async function restartBatchStatus(client: SQL, id?: string, actor?: string) {
    const [row] = await client<
        { value: RestartBatch }[]
    >`SELECT value FROM operation_snapshots s WHERE key LIKE 'maintenance.batch:%' AND (${id ?? null}::text IS NULL OR (key=${prefix + (id ?? "")} AND
        (value->>'actor'=${actor ?? null} OR (value->>'actor'='system:updates' AND EXISTS (SELECT 1 FROM job_runs j WHERE j.id=(s.value->>'parent')::uuid AND j.requested_by=${actor ?? null})))))
        ORDER BY (value->>'phase'='running') DESC,(value->>'phase'='waiting') DESC,captured_at DESC LIMIT 1`;
    if (!row) return null;
    return readRestartProgress(client, row.value, Boolean(id));
}

/** Read progress for a selected, authorized batch, including provable pre-dispatch expirations
 * recorded before workers emitted explicit refusal receipts.
 * @param client - Operations database that holds the child receipts.
 * @param batch - Durable batch selected under the caller's access rules.
 * @param liveMessages - Include worker messages for an owner-authorized detail.
 * @returns Public counts, evidence for individual outcomes and current progress.
 */
export async function readRestartProgress(
    client: SQL,
    batch: RestartBatch,
    liveMessages = false
) {
    const candidates = batch.steps.flatMap((s) =>
        s.state === "failed" && s.channel === "job" && s.child && !s.notStarted
            ? [s.child]
            : []
    );
    if (candidates.length > 0) {
        const expired = await client<
            { id: string }[]
        >`SELECT id FROM job_runs WHERE id=ANY(${client.array(candidates, "UUID")})
            AND (starts_with(action,'maintenance.reported.') OR starts_with(action,'maintenance.restart.'))
            AND state='failed' AND attempt=1 AND NOT retry_safe AND results='[]'::jsonb
            AND started_at>created_at+interval '5 minutes'`;
        const ids = new Set(expired.map((row) => row.id));
        batch = {
            ...batch,
            steps: batch.steps.map((step) =>
                step.state === "failed" &&
                step.channel === "job" &&
                !step.notStarted &&
                step.child &&
                ids.has(step.child)
                    ? {
                          ...step,
                          notStarted: true,
                          reason: "Confirmation expired in the worker queue before the restart was sent.",
                      }
                    : step
            ),
        };
    }
    return summarizeRestartBatch(
        batch,
        liveMessages ? await activeRestartMessages(client, [batch]) : undefined
    );
}

/** Read progress for the active worker children of already authorized batches.
 * @param client - Operations database.
 * @param batches - Restart records selected for this reader.
 * @returns Safe queue or execution messages keyed by child ID.
 */
export async function activeRestartMessages(
    client: SQL,
    batches: readonly RestartBatch[]
) {
    const ids = batches.flatMap((batch) =>
        batch.steps.flatMap((step) =>
            step.state === "running" && step.channel === "job" && step.child
                ? [step.child]
                : []
        )
    );
    if (ids.length === 0) return new Map<string, string>();
    const rows = await client<{ id: string; message: string }[]>`SELECT id,
        coalesce(${queueMessage(client)},CASE WHEN state='running' THEN 'Running the restart.'
          ELSE 'Checking the result.' END) AS message FROM job_runs WHERE id=ANY(${client.array(ids, "UUID")})`;
    return new Map(rows.map((row) => [row.id, row.message]));
}

/** Describe services waiting for a measurement or being processed by a worker or controller.
 * @param steps - Persisted stages of the selected batch.
 * @param messages - Current worker progress indexed by child ID.
 * @returns Operator-visible service names and the reason each is active.
 */
export function activeRestartSteps(
    steps: readonly RestartStep[],
    messages: ReadonlyMap<string, string>
) {
    return steps
        .filter(
            (step) =>
                step.state === "running" ||
                (step.state === "waiting" && step.waitingSince)
        )
        .map((step) => ({
            target: `${step.hostLabel} · ${step.label}`,
            message:
                step.state === "waiting"
                    ? "Waiting for a fresh restart check."
                    : (messages.get(step.child ?? "") ??
                      (step.channel === "controller"
                          ? "Awaiting Proxmox verification."
                          : "Checking the restart result.")),
        }));
}

function stepDetails(step: RestartStep) {
    return {
        target: new Bun.CryptoHasher("sha256")
            .update(JSON.stringify([step.host, step.unit]))
            .digest("hex"),
        label: `${step.hostLabel} · ${step.label}`,
        reason: step.reason ?? "Review restart status.",
    };
}

/** Project a persisted restart batch into public counts and operator-safe progress.
 * @param batch - Durable, server-owned operation.
 * @param messages - Latest progress for this batch's active jobs.
 * @returns Displayable progress without connection details or service identity evidence.
 */
export function summarizeRestartBatch(
    { id, steps, phase }: RestartBatch,
    messages = new Map<string, string>()
) {
    const followUp = steps
        .filter((step) => step.state === "failed")
        .map((step) => stepDetails(step));
    return {
        id,
        phase,
        total: steps.length,
        completed: steps.filter((s) => s.state === "done").length,
        skipped: steps.filter((s) => s.state === "skipped").length,
        skippedServices: steps
            .filter((step) => step.state === "skipped")
            .map((step) => stepDetails(step)),
        failed: steps.filter((s) => s.state === "failed" && s.child && !s.notStarted)
            .length,
        notAttempted: steps.filter(
            (s) => s.state === "failed" && (!s.child || s.notStarted)
        ).length,
        followUp,
        pending: steps.filter((s) => s.state === "waiting").length,
        active:
            steps
                .filter((s) => s.state === "running")
                .map((step) => step.label)
                .join(" · ") || null,
        activeSteps: activeRestartSteps(steps, messages),
    };
}
