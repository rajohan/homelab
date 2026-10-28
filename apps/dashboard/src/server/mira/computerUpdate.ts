import {
    miraComputerUpdateSchema,
    type MiraComputerUpdate,
} from "@homelab/contracts/miraComputerUpdates";
import { requireComputerDevice } from "@homelab/mira/data/computerAuthority";
import type { SQL } from "bun";
import * as v from "valibot";

import { releaseSnapshot } from "../integrations/releases/snapshot";

/**
 * Read existing release evidence under the paired device's authorization fence without issuing control access.
 * @param client - Operations database, never the identity database.
 * @param repository - Deployment-configured source shared with the release worker.
 * @param token - Computer-only credential; pairing tickets and browser identities are not accepted.
 * @returns Bounded-lived Windows update metadata or null when current evidence is unavailable.
 */
export async function computerUpdate(
    client: SQL,
    repository: string | undefined,
    token: string
): Promise<{ update: MiraComputerUpdate | null }> {
    return await client.begin(async (query) => {
        await requireComputerDevice(query, token);
        const snapshot = await releaseSnapshot(query, repository);
        const candidate =
            snapshot?.fresh && snapshot.value.verified ? snapshot.value.computer : null;
        if (!candidate || !snapshot) return { update: null };
        const validForMs = Math.min(
            300_000,
            Date.parse(snapshot.capturedAt) + 20 * 60_000 - Date.now()
        );
        const parsed = v.safeParse(miraComputerUpdateSchema, {
            repository,
            version: candidate.version,
            revision: candidate.revision,
            size: candidate.size,
            sha256: candidate.sha256,
            validForMs,
        });
        return { update: parsed.success ? parsed.output : null };
    });
}
