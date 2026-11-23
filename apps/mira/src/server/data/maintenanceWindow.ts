import type { SQL, TransactionSQL } from "bun";

/** Read the operation that owns the shared dashboard and Mira drain.
 * @param query - Shared dashboard database or queue transaction.
 * @returns The current maintenance ID when work needs to drain.
 */
export async function activeMaintenanceWindow(query: SQL | TransactionSQL) {
    const [record] = await query<{ id: string }[]>`
        SELECT id FROM release_deployments WHERE finished_at IS NULL
        UNION ALL SELECT (value->>'id')::uuid FROM operation_snapshots WHERE key='maintenance.proxmox.active'
        LIMIT 1`;
    return record;
}
