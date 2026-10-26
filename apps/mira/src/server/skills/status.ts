import type { MiraSkillSummary } from "@homelab/contracts/miraSkills";

import type { MiraQuery } from "../data/context";
import { miraSkillCatalogHash } from "./catalog";

/**
 * Compare the running executor's fresh catalogue receipt with this installed bundle.
 * @param query - Dashboard or scheduler connection; no identity/provider data is returned.
 * @returns Availability, missing liveness or a required matching executor deployment.
 */
export async function miraSkillsCompatibility(
    query: MiraQuery
): Promise<MiraSkillSummary["compatibility"]> {
    const [runtime] = await query<
        { ready: boolean; fresh: boolean; hash: string | null; matched: boolean }[]
    >`
        SELECT ready,heartbeat_at>clock_timestamp()-interval '45 seconds' AS fresh,
            skill_catalog_hash AS hash, skill_catalog_worker_id=worker_id AS matched FROM mira_runtime_status WHERE id=1`;
    if (!runtime?.ready || !runtime.fresh) return "offline";
    return runtime.matched && runtime.hash === miraSkillCatalogHash
        ? "available"
        : "update_required";
}
