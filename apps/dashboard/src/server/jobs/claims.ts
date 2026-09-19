import type { SQL } from "bun";

import type { Transaction } from "../database/connection";
import { notifyJobOutcome } from "../notifications/jobOutcome";
import { auditOperation } from "../operations/audit";
import { lockQueue } from "./queue";
import type { ClaimedJob } from "./types";

export const claimLeaseSeconds = 30;

/**
 * Recover expired claims and acquire one runnable job and all of its resources atomically.
 * @param client - The dashboard database pool.
 * @param workerId - This process's unique registration ID.
 * @param actionKeys - The exact executable inventory for this worker.
 * @returns A fenced job claim, or undefined when no admissible work exists.
 */
export async function claimJob(
    client: SQL,
    workerId: string,
    actionKeys: readonly string[]
): Promise<ClaimedJob | undefined> {
    return client.begin(async (transaction) => {
        await lockQueue(transaction);
        const expired = await transaction<
            {
                id: string;
                retry_safe: boolean;
                attempt: number;
                attempt_limit: number;
                cancel_requested: boolean;
            }[]
        >`SELECT id, retry_safe, attempt, attempt_limit, cancel_requested FROM job_runs WHERE state = 'running' AND lease_expires_at <= now() LIMIT 100 FOR UPDATE SKIP LOCKED`;
        for (const run of expired) {
            const retryState =
                run.retry_safe && run.attempt < run.attempt_limit ? "queued" : "failed";
            const state = run.cancel_requested ? "cancelled" : retryState;
            await transaction`DELETE FROM resource_leases WHERE run_id = ${run.id}`;
            await transaction`UPDATE job_runs SET state = ${state}, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, available_at = now() + interval '5 seconds', finished_at = CASE WHEN ${state} = 'queued' THEN NULL ELSE now() END, message = 'Worker ownership expired; external outcome may be unknown.' WHERE id = ${run.id}`;
            await auditOperation(
                transaction,
                "system:recovery",
                `jobs.${state}`,
                run.id,
                "Worker ownership expired; external outcome may be unknown."
            );
            await notifyJobOutcome(transaction, run.id);
        }
        const [control] = await transaction<
            { paused: boolean }[]
        >`SELECT paused FROM worker_control WHERE id = 1`;
        if (control?.paused) return;
        const candidates = await transaction<
            ClaimedJob[]
        >`SELECT id, action, payload, attempt, attempt_limit, retry_safe, timeout_ms, resource_keys FROM job_runs WHERE state = 'queued' AND available_at <= now() AND action = ANY(${transaction.array([...actionKeys], "TEXT")}) AND NOT EXISTS (SELECT 1 FROM resource_leases WHERE key = ANY(job_runs.resource_keys)) AND NOT EXISTS (SELECT 1 FROM job_runs active WHERE active.state = 'running' AND (active.resource_class = 'exclusive' OR job_runs.resource_class = 'exclusive' OR (active.resource_class = 'host-heavy' AND job_runs.resource_class = 'host-heavy'))) ORDER BY priority DESC, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        const run = candidates[0];
        if (!run) return;
        const token = Bun.randomUUIDv7();
        await transaction`UPDATE job_runs SET state = 'running', attempt = attempt + 1, started_at = now(), worker_id = ${workerId}, lease_token = ${token}, lease_expires_at = now() + ${claimLeaseSeconds} * interval '1 second', message = NULL WHERE id = ${run.id}`;
        for (const key of run.resource_keys)
            await transaction`INSERT INTO resource_leases (key, run_id, lease_token) VALUES (${key}, ${run.id}, ${token})`;
        await auditOperation(transaction, `worker:${workerId}`, "jobs.started", run.id);
        return { ...run, attempt: run.attempt + 1, lease_token: token };
    });
}

/**
 * Renew a claim only while it remains live and has not been cancelled.
 * @param client - The dashboard database pool.
 * @param run - The acquired run and fence token.
 * @returns Whether execution may continue.
 */
export async function renewClaim(client: SQL, run: ClaimedJob): Promise<boolean> {
    const rows = await client<
        { id: string }[]
    >`UPDATE job_runs SET lease_expires_at = now() + ${claimLeaseSeconds} * interval '1 second' WHERE id = ${run.id} AND state = 'running' AND lease_token = ${run.lease_token} AND lease_expires_at > now() AND NOT cancel_requested RETURNING id`;
    return rows.length === 1;
}

/**
 * Commit integration results only inside the still-owned claim transaction.
 * @param client - The dashboard database pool.
 * @param run - The current job fence.
 * @param write - A bounded database-only result writer.
 * @returns False if ownership or cancellation prevents the commit.
 */
export async function commitClaim(
    client: SQL,
    run: ClaimedJob,
    write: (transaction: Transaction) => Promise<void>
): Promise<boolean> {
    return client.begin(async (transaction) => {
        const rows = await transaction<
            { id: string }[]
        >`SELECT id FROM job_runs WHERE id = ${run.id} AND state = 'running' AND lease_token = ${run.lease_token} AND lease_expires_at > now() AND NOT cancel_requested FOR UPDATE`;
        if (rows.length !== 1) return false;
        await write(transaction);
        return true;
    });
}

/**
 * Settle a still-owned claim and release resources with an atomic audit record.
 * @param client - The dashboard database pool.
 * @param run - The acquired job and fence.
 * @param outcome - Classified execution result; private error messages are never persisted.
 * @returns Completion after settlement or a safe no-op for a stale worker.
 */
export async function settleClaim(
    client: SQL,
    run: ClaimedJob,
    outcome: "succeeded" | "failed" | "interrupted" | "timed_out"
): Promise<void> {
    await client.begin(async (transaction) => {
        await lockQueue(transaction);
        const current = await transaction<
            { cancel_requested: boolean }[]
        >`SELECT cancel_requested FROM job_runs WHERE id = ${run.id} AND state = 'running' AND lease_token = ${run.lease_token} AND lease_expires_at > now() FOR UPDATE`;
        if (!current[0]) return;
        const terminalState = outcome === "timed_out" ? "timed_out" : "failed";
        let state =
            run.retry_safe && run.attempt < run.attempt_limit ? "queued" : terminalState;
        if (outcome === "succeeded") state = "succeeded";
        if (current[0].cancel_requested) state = "cancelled";
        const messages = {
            succeeded: null,
            interrupted: "Execution was interrupted.",
            timed_out: "Execution exceeded its time limit.",
            failed: "Execution failed; inspect the integration's health and configuration.",
        } as const;
        const message = messages[outcome];
        await transaction`UPDATE job_runs SET state = ${state}, lease_token = NULL, lease_expires_at = NULL, worker_id = NULL, finished_at = CASE WHEN ${state} = 'queued' THEN NULL ELSE now() END, available_at = now() + ${Math.min(60, 2 ** run.attempt)} * interval '1 second', message = ${message} WHERE id = ${run.id}`;
        await transaction`DELETE FROM resource_leases WHERE run_id = ${run.id} AND lease_token = ${run.lease_token}`;
        await auditOperation(
            transaction,
            "system:worker",
            `jobs.${state}`,
            run.id,
            message
        );
        await notifyJobOutcome(transaction, run.id);
    });
}
