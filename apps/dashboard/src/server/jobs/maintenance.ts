import { availabilityRetentionDays } from "@homelab/contracts/infrastructure";
import * as v from "valibot";

import type { JobHandler } from "./types";

/**
 * Define bounded maintenance of completed jobs and operational metadata.
 * @param retentionDays - Deployment-controlled completed history retention.
 * @returns An hourly cleanup job that never deletes queued/running work or live tokens.
 */
export function maintenanceJob(retentionDays: number): JobHandler {
    return {
        definition: {
            key: "system.retention",
            label: "Clean expired operational history",
            description:
                "Remove expired completed runs, audit records and stale worker metadata within the retention policy.",
            resourceClass: "light",
            capability: "operations:maintain",
            resourceKeys: ["maintenance:operations"],
            timeoutMs: 30_000,
            attemptLimit: 3,
            retrySafe: true,
            intervalSeconds: 3600,
            validate: (input) => v.parse(v.strictObject({}), input),
        },
        execute: async (_payload, context) => {
            await context.reportProgress(
                "Removing expired operational history and stale worker metadata."
            );
            if (
                !(await context.commit(async (transaction) => {
                    const retired = await transaction<
                        { id: string }[]
                    >`SELECT id FROM workers WHERE (draining OR heartbeat_at < now() - interval '5 minutes') ORDER BY heartbeat_at LIMIT 1000 FOR UPDATE SKIP LOCKED`;
                    // A fresh statement snapshot sees claims committed before the row lock.
                    // Locked rows exclude new claims until this transaction completes.
                    if (retired.length > 0)
                        await transaction`DELETE FROM workers WHERE id = ANY(${transaction.array(
                            retired.map((worker) => worker.id),
                            "UUID"
                        )}) AND (draining OR heartbeat_at < now() - interval '5 minutes') AND NOT EXISTS (SELECT 1 FROM job_runs WHERE worker_id = workers.id AND state = 'running')`;
                    await transaction`DELETE FROM operation_rate_windows WHERE expires_at < now() - interval '1 day'`;
                }))
            )
                throw new Error("Maintenance ownership changed");
            let more: boolean;
            do {
                context.signal.throwIfAborted();
                more = false;
                if (
                    !(await context.commit(async (transaction) => {
                        // Keep the entire UTC day that crosses the rolling window's lower edge.
                        const cutoff = transaction`((now() AT TIME ZONE 'UTC')::date - date '1970-01-01' - ${availabilityRetentionDays}::int)`;
                        const expiredDays = await transaction<{ day: number }[]>`
                            DELETE FROM availability_days WHERE (kind, resource, day) IN (
                                SELECT kind, resource, day FROM availability_days WHERE day < ${cutoff} LIMIT 2000
                            ) RETURNING day`;
                        await transaction`DELETE FROM availability_backfill c WHERE next_day < ${cutoff}
                            AND NOT EXISTS (SELECT 1 FROM availability_days d WHERE d.kind=c.kind AND d.resource=c.resource)`;
                        const jobs = await transaction<
                            { id: string }[]
                        >`DELETE FROM job_runs WHERE id IN (SELECT id FROM job_runs WHERE state IN ('succeeded','failed','timed_out','cancelled') AND finished_at < now() - ${retentionDays} * interval '1 day' LIMIT 1000) RETURNING id`;
                        const audit = await transaction<
                            { id: string }[]
                        >`DELETE FROM operation_audit WHERE id IN (SELECT id FROM operation_audit WHERE created_at < now() - ${retentionDays} * interval '1 day' LIMIT 5000) RETURNING id`;
                        const batches = await transaction<
                            { key: string }[]
                        >`DELETE FROM operation_snapshots WHERE key IN (
                            SELECT key FROM operation_snapshots WHERE key LIKE 'maintenance.batch:%'
                            AND value->>'phase' IN ('complete','attention')
                            AND captured_at < now() - ${retentionDays} * interval '1 day' LIMIT 1000) RETURNING key`;
                        const incidents = await transaction<
                            { id: string }[]
                        >`DELETE FROM operational_incidents WHERE id IN (SELECT id FROM operational_incidents WHERE state = 'resolved' AND resolved_at < now() - ${retentionDays} * interval '1 day' ORDER BY id LIMIT 1000) RETURNING id`;
                        const rows = await transaction<
                            { id: string }[]
                        >`DELETE FROM dashboard_notifications WHERE id IN (SELECT id FROM dashboard_notifications WHERE created_at < now() - ${retentionDays} * interval '1 day' ORDER BY id LIMIT 1000) RETURNING id`;
                        more =
                            expiredDays.length === 2000 ||
                            jobs.length === 1000 ||
                            batches.length === 1000 ||
                            audit.length === 5000 ||
                            incidents.length === 1000 ||
                            rows.length === 1000;
                    }))
                )
                    throw new Error("Maintenance ownership changed");
            } while (more);
            await context.reportProgress("Operational history cleanup completed.");
        },
    };
}
