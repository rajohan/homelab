import { activeMaintenanceWindow } from "@homelab/mira/data/maintenanceWindow";
import type { SQL, TransactionSQL } from "bun";

import { lockQueue } from "../../jobs/queue";
import type { JobHandler } from "../../jobs/types";
import { OperationFailure } from "../../operations/errors";
import type { UpdateTarget } from "../updates/configuration";
import {
    finishRestartBatch,
    type RestartBatch,
    type RestartStep,
    saveRestartBatch,
} from "./batch";
import type { MaintenanceTarget } from "./configuration";
import { dispatchRestart, type FleetEntry } from "./dispatch";
import { fleetMaintenancePlans } from "./fleetPlans";
import { requiresNewSshConnection } from "./reportedTarget";

async function childState(tx: TransactionSQL, step: RestartStep) {
    if (step.channel === "controller") {
        const [row] = await tx<
            { state: string; recent: boolean }[]
        >`SELECT value->>'phase' AS state,captured_at>=now()-interval '1 hour' AS recent FROM operation_snapshots WHERE key=${"maintenance.proxmox.run:" + step.child}`;
        let state: "done" | "running" | "failed" = "failed";
        if (row?.state === "verified") state = "done";
        if (row?.state === "waiting" || row?.state === "submitted") state = "running";
        return {
            state,
            recent: row?.recent ?? false,
            refusal:
                row?.state === "refused"
                    ? "The controller declined the restart before dispatch. Review the current requirement."
                    : null,
        } as const;
    }
    const [row] = await tx<
        { state: string; warnings: boolean; recent: boolean; refusal: string | null }[]
    >`SELECT state,finished_at>=now()-interval '1 hour' AS recent,
        EXISTS(SELECT 1 FROM jsonb_array_elements(results) AS r WHERE jsonb_array_length(r->'warnings')>0) AS warnings,
        (SELECT r#>>'{warnings,0}' FROM jsonb_array_elements(results) AS r WHERE r->>'operation'='restart-not-started' LIMIT 1) AS refusal
        FROM job_runs WHERE id=${step.child!}`;
    let state: "done" | "running" | "failed" = "failed";
    if (row?.state === "queued" || row?.state === "running") state = "running";
    if (row?.state === "succeeded" && !row.warnings) state = "done";
    return {
        state,
        recent: row?.recent ?? false,
        refusal: row?.refusal ?? null,
    } as const;
}

async function dispatchStep(
    tx: TransactionSQL,
    step: RestartStep,
    batch: RestartBatch,
    registry: ReadonlyMap<string, JobHandler>,
    entry: FleetEntry | undefined,
    host: FleetEntry | undefined
) {
    const measured =
        host?.plan.fleetEvidence === "measured" &&
        Date.parse(host.plan.capturedAt ?? "") >= step.checkedAfter;
    if (host) step.hostLabel = host.plan.host.label;
    if (entry) step.label = entry.target.label;
    if (
        !measured ||
        (entry &&
            !entry.plan.external &&
            (!entry.plan.observed ||
                entry.plan.required === null ||
                (entry.plan.required && !entry.plan.allowed)))
    ) {
        if (step.waitingSince && Date.now() - step.waitingSince > 300_000) {
            step.state = "failed";
            step.reason = "A current restart measurement was unavailable.";
        } else if (step.waitingSince) return false;
        else step.waitingSince = Date.now();
    } else if (
        !entry ||
        entry.plan.required === false ||
        host?.observation?.bootId !== step.bootId
    ) {
        step.state = "skipped";
        step.reason = "The host or service no longer requires this restart.";
    } else if (entry.plan.external || !step.invocationId) {
        step.state = "failed";
        step.reason = entry.plan.reason ?? "Manual restart required.";
    } else if (
        entry.observation?.invocationId !== step.invocationId ||
        (step.configuration && step.configuration !== entry.configuration)
    ) {
        step.state = "failed";
        step.reason =
            "The service changed and still needs a restart. Review its current state.";
    } else {
        try {
            const child = await dispatchRestart(
                tx,
                registry,
                entry,
                batch.actor,
                Bun.randomUUIDv7(),
                true
            );
            step.state = "running";
            step.child = child.id;
            step.channel = child.channel;
            step.resourceKeys = registry.get(entry.action)?.definition.resourceKeys;
        } catch (error) {
            if (!(error instanceof OperationFailure)) throw error;
            if (error.code === "TOO_MANY_REQUESTS") return false;
            step.state = "failed";
            step.reason = error.message;
        }
    }
    return true;
}

/** Reconcile completed children and admit independent hosts under the normal queue leases.
 * @param client - Worker database.
 * @param targets - Configured restart authority.
 * @param connections - Configured remote hosts.
 * @param registry - Current worker queue handlers.
 */
export async function coordinateRestartBatches(
    client: SQL,
    targets: readonly MaintenanceTarget[],
    connections: readonly UpdateTarget[],
    registry: ReadonlyMap<string, JobHandler>
) {
    const [pending] = await client<
        { key: string }[]
    >`SELECT key FROM operation_snapshots WHERE key LIKE 'maintenance.batch:%' AND value->>'phase' IN ('waiting','running') LIMIT 1`;
    if (!pending) return;
    await client.begin(async (tx) => {
        await lockQueue(tx);
        if (await activeMaintenanceWindow(tx)) return;
        const [row] = await tx<
            { value: RestartBatch; expired: boolean }[]
        >`SELECT s.value,s.captured_at<now()-interval '1 hour' AND NOT(s.value ? 'parent') AS expired
          FROM operation_snapshots s WHERE s.key LIKE 'maintenance.batch:%' AND s.value->>'phase' IN ('waiting','running')
          AND NOT EXISTS(SELECT 1 FROM job_runs j WHERE j.id=(s.value->>'parent')::uuid AND j.state IN ('queued','running'))
          ORDER BY (s.value->>'phase'='running') DESC,(s.value->>'requested')::bigint,s.key LIMIT 1 FOR UPDATE`;
        if (!row) return;
        const batch = row.value;
        let changed = false;
        let recentCompletion = false;
        const busyHosts = new Set<string>();
        const busyResources = new Set<string>();
        let exclusive = false;
        for (const step of batch.steps.filter((s) => s.state === "running")) {
            const { state: outcome, recent, refusal } = await childState(tx, step);
            if (outcome === "running") {
                busyHosts.add(step.host.toLowerCase());
                for (const key of step.resourceKeys ?? []) busyResources.add(key);
                exclusive ||=
                    step.channel === "controller" ||
                    requiresNewSshConnection(step.unit) ||
                    !step.resourceKeys;
                continue;
            }
            changed = true;
            recentCompletion ||= recent;
            step.state = outcome;
            if (outcome === "failed") {
                if (refusal) {
                    step.notStarted = true;
                    step.reason = refusal;
                    continue;
                }
                step.reason =
                    "Recovery was not verified. Inspect the service before retrying.";
                for (const remaining of batch.steps.filter(
                    (s) => s.state === "waiting" && s.host === step.host
                )) {
                    remaining.state = "failed";
                    remaining.reason = "Paused after an unverified restart on this host.";
                }
            }
        }
        const [control] = await tx<{ paused: boolean; capacity: number }[]>`SELECT
            coalesce((SELECT paused FROM worker_control WHERE id=1),false) AS paused,
            coalesce(sum(capacity-reserved_capacity),0)::int AS capacity
            FROM workers WHERE NOT draining AND heartbeat_at>clock_timestamp()-interval '30 seconds'`;
        const capacity = control?.capacity ?? 0;
        const waiting = batch.steps.filter((step) => step.state === "waiting");
        if (row.expired && !recentCompletion && !control?.paused) {
            for (const step of waiting) {
                step.state = "failed";
                step.reason =
                    "Confirmation expired after an hour without progress. Review current requirements.";
            }
            changed ||= waiting.length > 0;
        } else if (
            waiting.length > 0 &&
            !control?.paused &&
            !exclusive &&
            busyHosts.size < capacity
        ) {
            const entries = await fleetMaintenancePlans(tx, targets, connections);
            const addresses = new Map(
                connections.map((connection) => [
                    connection.id,
                    connection.host.toLowerCase(),
                ])
            );
            const visited = new Set(busyHosts);
            for (const step of waiting) {
                const address = step.host.toLowerCase();
                if (visited.has(address)) continue;
                visited.add(address);
                const host = entries.find(
                    (e) =>
                        addresses.get(e.target.connection) === address &&
                        e.target.kind === "host"
                );
                const entry = entries.find(
                    (e) =>
                        addresses.get(e.target.connection) === address &&
                        e.plan.unit === step.unit &&
                        (!step.target || step.target === e.target.id)
                );
                const exclusiveStep = Boolean(
                    entry?.target.proxmox || requiresNewSshConnection(step.unit)
                );
                const resourceKeys = entry
                    ? registry.get(entry.action)?.definition.resourceKeys
                    : undefined;
                if (
                    (exclusiveStep && busyHosts.size > 0) ||
                    resourceKeys?.some((key) => busyResources.has(key))
                )
                    continue;
                const advanced = await dispatchStep(
                    tx,
                    step,
                    batch,
                    registry,
                    entry,
                    host
                );
                changed ||= advanced;
                if (step.state === "running") {
                    busyHosts.add(address);
                    for (const key of resourceKeys ?? []) busyResources.add(key);
                    if (exclusiveStep || busyHosts.size >= capacity) break;
                }
            }
        }
        if (!changed) return;
        batch.phase = "running";
        await finishRestartBatch(tx, batch);
        await saveRestartBatch(tx, batch);
    });
}
