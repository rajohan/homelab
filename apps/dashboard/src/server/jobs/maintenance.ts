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
                    await transaction`DELETE FROM job_runs WHERE id IN (SELECT id FROM job_runs WHERE state IN ('succeeded','failed','timed_out','cancelled') AND finished_at < now() - ${retentionDays} * interval '1 day' LIMIT 1000)`;
                    await transaction`DELETE FROM operation_audit WHERE id IN (SELECT id FROM operation_audit WHERE created_at < now() - ${retentionDays} * interval '1 day' LIMIT 5000)`;
                    await transaction`DELETE FROM workers WHERE heartbeat_at < now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM job_runs WHERE worker_id = workers.id AND state = 'running')`;
                    await transaction`DELETE FROM operation_rate_windows WHERE expires_at < now() - interval '1 day'`;
                }))
            )
                throw new Error("Maintenance ownership changed");
            let removed: number;
            do {
                context.signal.throwIfAborted();
                removed = 0;
                if (
                    !(await context.commit(async (transaction) => {
                        const rows = await transaction<
                            { id: string }[]
                        >`DELETE FROM dashboard_notifications WHERE id IN (SELECT id FROM dashboard_notifications WHERE created_at < now() - ${retentionDays} * interval '1 day' ORDER BY id LIMIT 1000) RETURNING id`;
                        removed = rows.length;
                    }))
                )
                    throw new Error("Maintenance ownership changed");
            } while (removed === 1000);
            await context.reportProgress("Operational history cleanup completed.");
        },
    };
}
