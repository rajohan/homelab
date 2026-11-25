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
import { dispatchRestart } from "./dispatch";
import { fleetMaintenancePlans } from "./fleetPlans";

async function childState(tx: TransactionSQL, step: RestartStep) {
    if (step.channel === "controller") {
        const [row] = await tx<
            { state: string }[]
        >`SELECT value->>'phase' AS state FROM operation_snapshots WHERE key=${"maintenance.proxmox.run:" + step.child}`;
        if (row?.state === "verified") return "done";
        if (row?.state === "waiting" || row?.state === "submitted") return "running";
        return "failed";
    }
    const [row] = await tx<
        { state: string; warnings: boolean }[]
    >`SELECT state, EXISTS(SELECT 1 FROM jsonb_array_elements(results) AS r WHERE jsonb_array_length(r->'warnings')>0) AS warnings FROM job_runs WHERE id=${step.child!}`;
    if (row?.state === "queued" || row?.state === "running") return "running";
    return row?.state === "succeeded" && !row.warnings ? "done" : "failed";
}

/** Advance one durable service restart at a time, waiting for installation and fresh host evidence.
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
            { value: RestartBatch }[]
        >`SELECT s.value FROM operation_snapshots s WHERE s.key LIKE 'maintenance.batch:%'
          AND s.value->>'phase' IN ('waiting','running') AND NOT EXISTS(SELECT 1 FROM job_runs j WHERE j.id=(s.value->>'parent')::uuid AND j.state IN ('queued','running'))
          ORDER BY (s.value->>'phase'='running') DESC, (s.value->>'requested')::bigint,s.key LIMIT 1 FOR UPDATE`;
        if (!row) return;
        const batch = row.value;
        const step =
            batch.steps.find((s) => s.state === "running") ??
            batch.steps.find((s) => s.state === "waiting");
        if (!step) return;
        if (step.state === "running") {
            const outcome = await childState(tx, step);
            if (outcome === "running") return;
            step.state = outcome;
            if (outcome === "failed") {
                step.reason =
                    "Recovery was not verified. Inspect the service before retrying.";
                for (const remaining of batch.steps.filter(
                    (s) => s.state === "waiting" && s.host === step.host
                )) {
                    remaining.state = "failed";
                    remaining.reason = "Paused after an unverified restart on this host.";
                }
            }
        } else {
            const [control] = await tx<
                { paused: boolean }[]
            >`SELECT paused FROM worker_control WHERE id=1`;
            if (control?.paused) return;
            const entries = await fleetMaintenancePlans(tx, targets, connections);
            const aliases = new Set(
                connections
                    .filter((c) => c.host.toLowerCase() === step.host.toLowerCase())
                    .map((c) => c.id)
            );
            const host = entries.find(
                (entry) =>
                    aliases.has(entry.target.connection) && entry.target.kind === "host"
            );
            if (host) step.hostLabel = host.plan.host.label;
            const entry = entries.find(
                (candidate) =>
                    aliases.has(candidate.target.connection) &&
                    candidate.plan.unit === step.unit &&
                    (!step.target || candidate.target.id === step.target)
            );
            if (entry) step.label = entry.target.label;
            const measured =
                host?.plan.fleetEvidence === "measured" &&
                Date.parse(host.plan.capturedAt ?? "") >= step.checkedAfter;
            const expired = !batch.parent && Date.now() - batch.requested > 3_600_000;
            if (expired) {
                step.state = "failed";
                step.reason = "Confirmation expired. Review current requirements.";
            } else if (
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
                } else if (step.waitingSince) return;
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
                    step.label = entry.target.label;
                } catch (error) {
                    if (!(error instanceof OperationFailure)) throw error;
                    if (error.code === "TOO_MANY_REQUESTS") return;
                    step.state = "failed";
                    step.reason = error.message;
                }
            }
        }
        batch.phase = "running";
        await finishRestartBatch(tx, batch);
        await saveRestartBatch(tx, batch);
    });
}
