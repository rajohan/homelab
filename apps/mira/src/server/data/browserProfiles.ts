import {
    miraBrowserProfileCreateSchema,
    miraBrowserProfileDeleteSchema,
    type MiraBrowserProfile,
} from "@homelab/contracts/miraBrowser";
import * as v from "valibot";

import { browserWorkerGrant } from "../browsing/wire";
import { lockBrowserOwner } from "./browserAccess";
import { auditMira, MiraFailure, type MiraContext } from "./context";

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
        SELECT p.id,p.name,p.origins,p.state,p.created_at AS "createdAt",
            EXISTS(SELECT 1 FROM mira_browser_access g WHERE g.profile_id=p.id AND g.state<>'closed') AS busy
        FROM mira_browser_profiles p WHERE p.owner=${context.owner} AND p.state<>'deleted'
        ORDER BY p.created_at,p.id LIMIT 4`;
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/**
 * Create an account-owned isolated profile with immutable approved website origins.
 * @returns The newly allocated profile identity; browser storage is created on its first use.
 */
export async function createMiraBrowserProfile(context: MiraContext, input: unknown) {
    human(context);
    const request = v.parse(miraBrowserProfileCreateSchema, input);
    let origins: string[];
    try {
        origins = browserWorkerGrant({
            origins: request.origins,
            initialUrl: request.origins[0],
            mode: "view",
        }).origins;
    } catch {
        throw new MiraFailure(
            "BAD_REQUEST",
            "Choose unique exact HTTP(S) origins without paths or credentials."
        );
    }
    return context.client.begin(async (query) => {
        await lockBrowserOwner(query, context.owner);
        const [counts] = await query<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_browser_profiles WHERE owner=${context.owner} AND state<>'deleted'`;
        if (counts!.count >= 4)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Delete an unused browser profile before creating another. Four profiles are allowed per account."
            );
        await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:browser:profile-capacity',0))`;
        const [slot] = await query<
            { slot: number }[]
        >`SELECT slot FROM generate_series(0,15) AS slot WHERE NOT EXISTS(SELECT 1 FROM mira_browser_profiles p WHERE p.quota_slot=slot) ORDER BY slot LIMIT 1`;
        if (!slot)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Saved browser profile storage is fully reserved. Delete an unused profile before creating another."
            );
        const id = Bun.randomUUIDv7();
        await query`INSERT INTO mira_browser_profiles(id,owner,name,origins,quota_slot) VALUES(${id},${context.owner},${request.name},${JSON.stringify(origins)}::text::jsonb,${slot.slot})`;
        await auditMira(query, context, "browser.profile_created", id);
        return { id };
    });
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
