import { activeMaintenanceWindow } from "@homelab/mira/data/maintenanceWindow";
import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import { lockQueue } from "../../jobs/queue";
import { auditOperation } from "../../operations/audit";
import { OperationFailure } from "../../operations/errors";
import type { UpdateTarget } from "../updates/configuration";
import { updateSshArguments } from "../updates/execution";
import { maintenanceRevision, type MaintenanceTarget } from "./configuration";
import type { MaintenanceObservation } from "./execution";
import nodeProgram from "./physicalNode.py" with { type: "text" };
import program from "./proxmox.py" with { type: "text" };
import { discoveredMaintenanceTarget, requiresNewSshConnection } from "./reportedTarget";

const marker = "maintenance.proxmox.active";
const journal = (id: string) => `maintenance.proxmox.run:${id}`;
const receipt = v.object({
    state: v.picklist([
        "missing",
        "accepted",
        "verifying",
        "verified",
        "refused",
        "unverified",
    ]),
});
type Restart = {
    id: string;
    actor: string;
    target: string;
    label: string;
    revision: string;
    configuration: string;
    expected: MaintenanceObservation;
    requiredOnly?: boolean;
    reportedHost?: string;
    unit?: string;
    started: number;
    phase: "waiting" | "submitted" | "verified" | "refused" | "unverified";
};

/** Return the durable operator-visible result across a dashboard or database restart.
 * @param client - Dashboard observation database.
 * @returns The latest confirmed request and its durable phase.
 */
export async function latestProxmoxRestart(client: SQL) {
    const [row] = await client<
        { label: string; phase: Restart["phase"]; started: string }[]
    >`
        SELECT value->>'label' AS label,value->>'phase' AS phase,captured_at::text AS started
        FROM operation_snapshots WHERE key LIKE 'maintenance.proxmox.run:%' ORDER BY captured_at DESC LIMIT 1`;
    return row ?? null;
}

/** Admit one operator-confirmed restart under the same queue lock as releases and claims.
 * @param tx - Admission transaction holding the queue lock.
 * @param record - Verified confirmation and expected guest identity.
 * @returns The operation ID tracked by the controller.
 */
export async function admitProxmoxRestart(
    tx: TransactionSQL,
    record: Omit<Restart, "phase" | "started">
) {
    if (await activeMaintenanceWindow(tx))
        throw new OperationFailure(
            "CONFLICT",
            "Another maintenance operation is already in progress."
        );
    const [clock] = await tx<
        { seconds: number }[]
    >`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS seconds`;
    const entry: Restart = {
        ...record,
        phase: "waiting",
        started: Number(clock!.seconds),
    };
    await tx`INSERT INTO operation_snapshots(key,value,captured_at) VALUES(${marker},${JSON.stringify({ id: entry.id })}::text::jsonb,now()),(${journal(entry.id)},${JSON.stringify(entry)}::text::jsonb,now())`;
    await auditOperation(
        tx,
        record.actor,
        "maintenance.proxmox.requested",
        record.target
    );
    return { id: entry.id };
}

async function callController(
    connection: UpdateTarget,
    payload: object,
    signal: AbortSignal,
    runner: string
) {
    const child = Bun.spawn(updateSshArguments(connection, runner), {
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: "pipe",
        stderr: "ignore",
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: "/nonexistent" },
    });
    try {
        let output = "";
        for await (const chunk of child.stdout) {
            if (output.length + chunk.length > 1024)
                throw new Error("Invalid controller response");
            output += new TextDecoder().decode(chunk);
        }
        if ((await child.exited) !== 0) throw new Error("Controller unavailable");
        return v.parse(receipt, JSON.parse(output) as unknown).state;
    } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
    }
}

/** Drain work, hand the approved operation to PVE once, then poll its independent receipt.
 * @param client - Dashboard database.
 * @param targets - Deployment-owned restart recipes.
 * @param connections - Pinned SSH configuration.
 * @param requireMiraDrain - Whether this deployment expects a Mira executor to acknowledge the restart.
 * @param signal - Worker lifetime.
 * @returns Completion of one coordination step.
 */
export async function coordinateProxmoxRestart(
    client: SQL,
    targets: readonly MaintenanceTarget[],
    connections: readonly UpdateTarget[],
    requireMiraDrain: boolean,
    signal: AbortSignal
) {
    const [active] = await client<
        { value: Restart }[]
    >`SELECT j.value FROM operation_snapshots a JOIN operation_snapshots j ON j.key='maintenance.proxmox.run:' || (a.value->>'id') WHERE a.key=${marker}`;
    if (!active) return;
    const run = active.value;
    const age = Date.now() / 1000 - run.started;
    async function finish(phase: "verified" | "unverified" | "refused") {
        await client.begin(async (tx) => {
            await lockQueue(tx);
            const removed = await tx<
                { key: string }[]
            >`DELETE FROM operation_snapshots WHERE key=${marker} AND value->>'id'=${run.id} AND EXISTS(SELECT 1 FROM operation_snapshots WHERE key=${journal(run.id)} AND value->>'phase'=${run.phase}) RETURNING key`;
            if (removed.length === 0) return;
            await tx`UPDATE operation_snapshots SET value=jsonb_set(value,'{phase}',to_jsonb(${phase}::text)) WHERE key=${journal(run.id)}`;
            await auditOperation(
                tx,
                "worker",
                `maintenance.proxmox.${phase}`,
                run.target
            );
        });
    }
    const host =
        run.reportedHost &&
        targets.find(
            (entry) =>
                entry.id === run.reportedHost &&
                entry.kind === "host" &&
                entry.restartReportedServices
        );
    const target =
        host && run.unit
            ? discoveredMaintenanceTarget(host, run.unit)
            : targets.find((entry) => entry.id === run.target);
    const connection = connections.find(
        (entry) =>
            entry.id ===
            (target?.physicalNode ? target.connection : target?.proxmox?.connection)
    );
    const guest =
        target?.proxmox && requiresNewSshConnection(target.service)
            ? connections.find((entry) => entry.id === target.connection)
            : undefined;
    if (
        !target ||
        target.id !== run.target ||
        (!target.proxmox && !target.physicalNode) ||
        !connection ||
        maintenanceRevision(target, connections) !== run.configuration
    ) {
        if (run.phase === "waiting") await finish("refused");
        else if (age > 1000) await finish("unverified");
        return;
    }
    if (run.phase === "waiting" && age >= 300) {
        await finish("refused");
        return;
    }
    if (age >= (target.physicalNode ? 3600 : 1000)) {
        await finish("unverified");
        return;
    }
    let submit = false;
    if (run.phase === "waiting") {
        const [ready] = await client<{ ready: boolean }[]>`SELECT
            NOT EXISTS(SELECT 1 FROM job_runs WHERE state='running')
            AND NOT EXISTS(SELECT 1 FROM workers WHERE heartbeat_at>clock_timestamp()-interval '30 seconds' AND (deployment_protocol<>1 OR deployment_drained_for IS DISTINCT FROM ${run.id}::uuid))
            AND (
                EXISTS(SELECT 1 FROM mira_runtime_status WHERE deployment_drained_for=${run.id} AND heartbeat_at>clock_timestamp()-interval '15 seconds')
                OR (NOT ${requireMiraDrain}::boolean AND NOT EXISTS(SELECT 1 FROM mira_runtime_status WHERE heartbeat_at>clock_timestamp()-interval '30 seconds'))
            )
            AND NOT EXISTS(SELECT 1 FROM mira_browser_processes WHERE state<>'removed')
            AND NOT EXISTS(SELECT 1 FROM mira_daytona_jobs WHERE execution_target='main' AND (state='running' OR cleanup='pending')) AS ready`;
        if (!ready?.ready) return;
        const changed = await client<
            { key: string }[]
        >`UPDATE operation_snapshots SET value=jsonb_set(value,'{phase}','"submitted"'::jsonb) WHERE key=${journal(run.id)} AND value->>'phase'='waiting' RETURNING key`;
        if (changed.length === 0) return;
        submit = true;
        run.phase = "submitted";
    }
    try {
        const runner = target.physicalNode ? nodeProgram : program;
        const result = await callController(
            connection,
            submit
                ? {
                      id: run.id,
                      mode: "submit",
                      program: runner,
                      target,
                      ...(guest
                          ? { guestSsh: { host: guest.host, port: guest.port ?? 22 } }
                          : {}),
                      expected: run.expected,
                      requiredOnly: run.requiredOnly ?? false,
                      expires: run.started + 300,
                  }
                : { id: run.id, mode: "read" },
            signal,
            runner
        );
        if (result === "verified" || result === "refused" || result === "unverified")
            await finish(result);
    } catch {
        // A lost SSH acknowledgement is reconciled by receipt only. A submitted restart is never resent.
        signal.throwIfAborted();
    }
}
