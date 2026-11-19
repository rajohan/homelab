import {
    type MiraBrowserProfile,
    miraBrowserProfileDeleteSchema,
} from "@homelab/contracts/miraBrowser";
import * as v from "valibot";

import { lockBrowserOwner } from "./browserAccess";
import { auditMira, type MiraContext, MiraFailure } from "./context";

function human(context: MiraContext) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Browser profiles require a signed-in operator."
        );
}

/**
 * List only this account's profile names and approved sites, never stored browser data.
 * @returns Up to four active or deleting profiles owned by the signed-in human.
 */
export async function listMiraBrowserProfiles(
    context: MiraContext
): Promise<MiraBrowserProfile[]> {
    human(context);
    const rows = await context.client<
        (Omit<MiraBrowserProfile, "createdAt"> & { createdAt: Date })[]
    >`
        SELECT p.id,p.name,p.origins,p.home_network AS "homeNetwork",p.state,p.created_at AS "createdAt",
            EXISTS(SELECT 1 FROM mira_browser_access g WHERE g.profile_id=p.id AND g.state<>'closed') AS busy
        FROM mira_browser_profiles p WHERE p.owner=${context.owner} AND p.state<>'deleted'
        ORDER BY p.created_at,p.id LIMIT 4`;
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/**
 * Erase a private snapshot and release its reserved capacity after all browser cleanup completes.
 * @returns Completion of the atomic owned deletion; no browser data is exposed.
 */
export async function deleteMiraBrowserProfile(
    context: MiraContext,
    input: unknown
): Promise<void> {
    human(context);
    const { id } = v.parse(miraBrowserProfileDeleteSchema, input);
    await context.client.begin(async (query) => {
        await lockBrowserOwner(query, context.owner);
        const [profile] = await query<{ hostId: string | null; busy: boolean }[]>`
            SELECT p.host_id AS "hostId",EXISTS(SELECT 1 FROM mira_browser_access g
                WHERE g.profile_id=p.id AND (g.state<>'closed' OR EXISTS(SELECT 1 FROM mira_browser_processes b WHERE b.access_id=g.id AND b.state<>'removed'))) AS busy
            FROM mira_browser_profiles p WHERE p.id=${id} AND p.owner=${context.owner} AND p.state='active'`;
        if (!profile) return;
        if (profile.busy)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Stop browser access and wait for cleanup before deleting its profile."
            );
        await query`UPDATE mira_browser_profiles SET state='deleted',snapshot=NULL,quota_slot=NULL WHERE id=${id}`;
        await auditMira(query, context, "browser.profile_deletion_requested", id);
    });
}
