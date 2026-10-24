import type { MiraQuery } from "./context";

/**
 * Reserve bounded queue space while retaining capacity for manually started work.
 * @param query - Enqueue transaction; its capacity lock remains held through insertion.
 * @param owner - Server-verified account.
 * @param manual - Explicit user initiation, never inferred from model content.
 * @returns Whether the transaction may insert another active run.
 */
export async function miraQueueAvailable(
    query: MiraQuery,
    owner: string,
    manual: boolean
): Promise<boolean> {
    await query`SELECT pg_advisory_xact_lock(hashtextextended('homelab:mira:queue-capacity', 0))`;
    const [counts] = await query<
        { owned: number; total: number }[]
    >`SELECT count(*)::int AS total, count(*) FILTER (WHERE owner = ${owner})::int AS owned FROM mira_runs WHERE state IN ('queued','running')`;
    return Boolean(
        counts && counts.total < (manual ? 128 : 120) && counts.owned < (manual ? 32 : 28)
    );
}
