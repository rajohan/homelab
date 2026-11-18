import type { TransactionSQL } from "bun";

import { auditMira, type MiraContext, MiraFailure } from "./context";

/** Reserve Mira's dedicated broad profile while the caller holds the owner lock.
 * @param query - The active manual browser admission transaction.
 * @param context - Verified owner and run, already checked by browser admission.
 * @param origins - Server-selected network scope; existing scoped profiles are never broadened.
 * @param homeNetwork - Current provisioned network binding.
 * @returns An existing or newly reserved profile ID, without its stored data.
 */
export async function reserveDefaultBrowserProfile(
    query: TransactionSQL,
    context: MiraContext,
    origins: string[],
    homeNetwork: boolean
): Promise<string> {
    const [existing] = await query<
        { id: string }[]
    >`SELECT id FROM mira_browser_profiles WHERE owner=${context.owner} AND state='active' AND origins=${JSON.stringify(origins)}::text::jsonb AND home_network=${homeNetwork} ORDER BY created_at,id LIMIT 1`;
    if (existing) return existing.id;
    const [count] = await query<
        { total: number }[]
    >`SELECT count(*)::int AS total FROM mira_browser_profiles WHERE owner=${context.owner} AND state<>'deleted'`;
    if (count!.total >= 4)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Saved profile capacity is full. Use a temporary browser or remove an unused profile in Browser settings."
        );
    await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:browser:profile-capacity',0))`;
    const [slot] = await query<
        { slot: number }[]
    >`SELECT slot FROM generate_series(0,15) AS slot WHERE NOT EXISTS(SELECT 1 FROM mira_browser_profiles p WHERE p.quota_slot=slot) ORDER BY slot LIMIT 1`;
    if (!slot)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Saved profile storage is full. Use a temporary browser."
        );
    const id = Bun.randomUUIDv7();
    await query`INSERT INTO mira_browser_profiles(id,owner,name,origins,home_network,quota_slot) VALUES(${id},${context.owner},'Mira',${JSON.stringify(origins)}::text::jsonb,${homeNetwork},${slot.slot})`;
    await auditMira(query, context, "browser.profile_created", id);
    return id;
}
