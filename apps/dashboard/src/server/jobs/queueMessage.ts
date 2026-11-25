import type { SQL } from "bun";

import { fitsControlSlot } from "./capacity";

/**
 * Describe a current queue blocker in the same database snapshot as the run.
 * @param client - Operations database with the public job_runs projection in scope.
 * @returns A message expression that preserves recorded progress and history.
 */
export function queueMessage(client: SQL) {
    return client`CASE WHEN job_runs.state='queued' AND job_runs.message IS NULL THEN
        CASE
            WHEN EXISTS (SELECT 1 FROM worker_control WHERE id=1 AND paused)
                THEN 'The worker queue is paused.'
            WHEN EXISTS (SELECT 1 FROM release_deployments WHERE finished_at IS NULL)
                THEN 'Waiting for the deployment to finish.'
            WHEN EXISTS (SELECT 1 FROM operation_snapshots WHERE key='maintenance.proxmox.active')
                THEN 'Waiting for Proxmox maintenance to finish.'
            WHEN job_runs.available_at>now() THEN 'Waiting for the retry delay to expire.'
            WHEN NOT EXISTS (SELECT 1 FROM workers WHERE NOT draining AND heartbeat_at>now()-interval '30 seconds')
                THEN 'Waiting for an online worker.'
            ELSE COALESCE((
                SELECT 'Waiting for “' || left(blocker.label,150) || '” to release ' ||
                    CASE WHEN starts_with(lease.key,'host:') THEN 'this host.' ELSE 'a shared resource.' END
                FROM resource_leases lease JOIN job_runs blocker ON blocker.id=lease.run_id
                WHERE lease.key=ANY(job_runs.resource_keys)
                ORDER BY starts_with(lease.key,'host:') DESC,blocker.started_at,blocker.id LIMIT 1
            ), CASE
                WHEN EXISTS (SELECT 1 FROM job_runs other WHERE other.state='running' AND other.resource_class='exclusive')
                    THEN 'An exclusive job is running.'
                WHEN job_runs.resource_class='exclusive' AND EXISTS (SELECT 1 FROM job_runs other WHERE other.state='running')
                    THEN 'This job needs all running work to finish.'
                WHEN job_runs.resource_class='host-heavy' AND EXISTS (SELECT 1 FROM job_runs other WHERE other.state='running' AND other.resource_class='host-heavy')
                    THEN 'Waiting for another host-heavy job to finish.'
                WHEN NOT EXISTS (
                    SELECT 1 FROM workers w CROSS JOIN LATERAL (
                        SELECT count(*) AS total, count(*) FILTER (WHERE NOT ${fitsControlSlot(client)}) AS general
                        FROM job_runs busy WHERE busy.state='running' AND busy.worker_id=w.id
                    ) occupancy WHERE NOT w.draining AND w.heartbeat_at>now()-interval '30 seconds'
                      AND occupancy.total<w.capacity AND (${fitsControlSlot(client)} OR occupancy.general<w.capacity-w.reserved_capacity)
                ) THEN CASE WHEN ${fitsControlSlot(client)} THEN 'All worker slots are busy.' ELSE 'Waiting for a general worker slot.' END
                ELSE 'Queued for execution.'
            END)
        END ELSE job_runs.message END`;
}
