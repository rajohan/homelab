import type { SQL } from "bun";

import { browserEngine } from "../browsing/engine";
import {
    createBrowserProfileVolume,
    inspectBrowserProfile,
    removeBrowserProfileVolume,
} from "../browsing/profile";
import { renewMiraBrowserProcess } from "./browserProcesses";

type Claim = Parameters<typeof renewMiraBrowserProcess>[1];

/**
 * Prepare the exclusively reserved profile before starting its browser container.
 * @returns A fixed volume identity, or undefined for a disposable profile. Missing saved data never silently becomes a fresh profile.
 */
export async function prepareMiraBrowserProfile(
    client: SQL,
    claim: Claim,
    configuration: unknown
) {
    const record = await renewMiraBrowserProcess(client, claim);
    if (!record.profileId) return;
    const engine = await browserEngine(configuration);
    const [row] = await client<{ id: string; storage: "new" | "creating" | "ready" }[]>`
        SELECT id,storage FROM mira_browser_profiles WHERE id=${record.profileId} AND host_id=${record.hostId} AND state='active'`;
    if (!row) throw new Error("The saved browser profile is unavailable.");
    const profile = { id: row.id };
    if (row.storage === "new") {
        if (await inspectBrowserProfile(engine.call, profile))
            throw new Error("Unexpected storage exists for a new browser profile.");
        await renewMiraBrowserProcess(client, claim);
        const [intent] = await client<{ id: string }[]>`
            UPDATE mira_browser_profiles SET storage='creating' WHERE id=${row.id} AND state='active' AND storage='new'
                AND EXISTS(SELECT 1 FROM mira_browser_processes p WHERE p.id=${record.id} AND p.host_id=${record.hostId}
                    AND p.lease_token=${record.claim.leaseToken} AND p.state='active' AND p.lease_expires_at>clock_timestamp()) RETURNING id`;
        if (!intent) throw new Error("Browser profile creation lost its process owner.");
        // One dispatch follows committed intent. Recovery never replays an uncertain creation.
        await createBrowserProfileVolume(engine.call, profile);
    } else if (!(await inspectBrowserProfile(engine.call, profile))) {
        throw new Error(
            "Saved browser storage is missing or creation remains uncertain."
        );
    }
    await renewMiraBrowserProcess(client, claim);
    const [ready] = await client<{ id: string }[]>`
        UPDATE mira_browser_profiles SET storage='ready' WHERE id=${row.id} AND state='active' AND host_id=${record.hostId}
            AND EXISTS(SELECT 1 FROM mira_browser_processes p WHERE p.id=${record.id} AND p.host_id=${record.hostId}
                AND p.lease_token=${record.claim.leaseToken} AND p.state='active' AND p.lease_expires_at>clock_timestamp()) RETURNING id`;
    if (!ready) throw new Error("Browser profile preparation lost its process owner.");
    return profile;
}

/**
 * Finish at most four human-requested deletions on their original local Docker host.
 * @returns Counts for host health. Unknown creation plus absence remains reserved for reconciliation.
 */
export async function cleanupMiraBrowserProfiles(
    client: SQL,
    configuration: { hostId: string; socketPath: string; imageId: string }
) {
    const engine = await browserEngine({
        socketPath: configuration.socketPath,
        imageId: configuration.imageId,
    });
    const candidates = await client<{ id: string; owner: string }[]>`
        SELECT id,owner FROM mira_browser_profiles WHERE host_id=${configuration.hostId} AND state='deleting' ORDER BY created_at,id LIMIT 4`;
    let removed = 0,
        unresolved = 0;
    for (const candidate of candidates) {
        try {
            const [row] = await client<{ storage: string }[]>`
                    SELECT storage FROM mira_browser_profiles p WHERE p.id=${candidate.id} AND p.host_id=${configuration.hostId} AND p.state='deleting'
                        AND NOT EXISTS(SELECT 1 FROM mira_browser_access g WHERE g.profile_id=p.id AND (g.state<>'closed'
                            OR EXISTS(SELECT 1 FROM mira_browser_processes b WHERE b.access_id=g.id AND b.state<>'removed')))`;
            if (!row) continue;
            const profile = { id: candidate.id };
            const exists = await inspectBrowserProfile(engine.call, profile);
            if (!exists && row.storage === "creating")
                throw new Error(
                    "An uncertain profile creation cannot be retired by absence alone."
                );
            if (exists) await removeBrowserProfileVolume(engine.call, profile);
            await client`UPDATE mira_browser_profiles SET state='deleted' WHERE id=${candidate.id} AND host_id=${configuration.hostId} AND state='deleting'`;
            removed++;
        } catch {
            unresolved++;
        }
    }
    return { removed, unresolved };
}
