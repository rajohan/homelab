import type { SQL } from "bun";

import type { BrowserProfilePersistence } from "../browsing/profile";
import { browserProfileSnapshot } from "../browsing/profileSnapshot";
import {
    renewMiraBrowserProcess,
    saveMiraBrowserProfileSnapshot,
} from "./browserProcesses";

type Claim = Parameters<typeof renewMiraBrowserProcess>[1];

/**
 * Bind a private bounded snapshot to the original host and this exact process lease.
 * @returns Private restore/save callbacks, or undefined for temporary browsing.
 */
export async function prepareMiraBrowserProfile(client: SQL, claim: Claim) {
    const record = await renewMiraBrowserProcess(client, claim);
    if (!record.profileId) return;
    const [row] = await client<{ id: string; snapshot: string | null }[]>`
        SELECT id,snapshot FROM mira_browser_profiles WHERE id=${record.profileId} AND host_id=${record.hostId} AND state='active'`;
    if (!row) throw new Error("The saved browser profile is unavailable.");
    if (row.snapshot !== null) browserProfileSnapshot(row.snapshot);
    const persistence: BrowserProfilePersistence = {
        snapshot: row.snapshot,
        save: (snapshot) =>
            saveMiraBrowserProfileSnapshot(client, record.claim, snapshot),
    };
    return { id: row.id, persistence };
}
