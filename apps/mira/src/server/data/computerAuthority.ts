import type { TransactionSQL } from "bun";

import { readComputerCredential } from "../computer/credentials";
import { MiraFailure, type MiraQuery } from "./context";

export interface AccessRow {
    id: string;
    owner: string;
    computerId: string;
    runId: string;
    mode: "view" | "control";
    state: "pending" | "active" | "stopped";
    connectionId: string;
    targetId: string | null;
    runLease: string;
    expiresAt: Date;
    consentExpiresAt: Date;
    expired: boolean;
    available: boolean;
    validForMs: number;
}

/**
 * Serialize computer authority with the account's pause and consent controls.
 * @param query - Owning transaction; acquire before computer or command row locks.
 * @param owner - Verified account identity.
 * @returns Completion after the account control lock is held.
 */
export async function lockComputerOwner(query: TransactionSQL, owner: string) {
    await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${owner}`},0))`;
}

/**
 * Read effective access including run lease, generation, pause versions and expiry.
 * @param query - Transaction already holding the owner's control lock for mutations.
 * @param owner - Verified account identity.
 * @param id - Exact consent request.
 * @returns Current authority metadata, or undefined without cross-account disclosure.
 */
export async function readComputerAccess(
    query: MiraQuery,
    owner: string,
    id: string
): Promise<AccessRow | undefined> {
    const [row] = await query<AccessRow[]>`
        SELECT g.id,g.owner,g.computer_id AS "computerId",g.run_id AS "runId",g.mode,g.state,
            g.connection_id AS "connectionId",g.target_id AS "targetId",g.run_lease AS "runLease",g.expires_at AS "expiresAt",
            least(g.expires_at,g.created_at+interval '1 minute') AS "consentExpiresAt",
            g.expires_at<=clock_timestamp() AS expired,
            (g.state IN ('pending','active') AND g.expires_at>clock_timestamp()
             AND (g.state<>'pending' OR g.created_at>clock_timestamp()-interval '1 minute')
             AND c.state='paired' AND c.version=g.computer_version AND c.connection_id=g.connection_id
             AND c.expires_at>clock_timestamp() AND c.connection_expires_at>clock_timestamp()
             AND r.state='running' AND NOT r.cancel_requested AND r.lease_token=g.run_lease
             AND r.lease_expires_at>clock_timestamp() AND r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp()
             AND v.deleted_at IS NULL AND coalesce(u.enabled,true)
             AND (r.automation_id IS NULL OR (a.deleted_at IS NULL AND s.enabled AND
                 (a.schedule->>'event' IS DISTINCT FROM 'agentmail' OR i.enabled)))
             AND NOT EXISTS (SELECT 1 FROM mira_computer_commands cmd JOIN mira_tool_receipts receipt ON receipt.id=cmd.id
                 WHERE cmd.access_id=g.id AND cmd.state IN ('queued','claimed','completed')
                 AND (cmd.expires_at<=clock_timestamp() OR receipt.state<>'running'))
             AND g.controls=jsonb_build_array(coalesce(u.version,1),a.version,s.version,
                 CASE WHEN a.schedule->>'event'='agentmail' THEN i.version END)
            ) IS TRUE AS available,
            greatest(0,least(5000,floor(extract(epoch FROM (least(g.expires_at,c.expires_at,c.connection_expires_at,r.lease_expires_at,
                r.started_at+r.budget_seconds*interval '1 second')-clock_timestamp()))*1000)))::int AS "validForMs"
        FROM mira_computer_access g JOIN mira_computers c ON c.id=g.computer_id AND c.owner=g.owner
        JOIN mira_runs r ON r.id=g.run_id AND r.owner=g.owner
        JOIN mira_conversations v ON v.id=r.conversation_id AND v.owner=g.owner
        LEFT JOIN mira_switches u ON u.owner=g.owner AND u.key='autonomy'
        LEFT JOIN mira_automations a ON a.id=r.automation_id AND a.owner=g.owner
        LEFT JOIN mira_switches s ON s.owner=g.owner AND s.key='automation:'||a.id::text
        LEFT JOIN mira_switches i ON i.owner=g.owner AND i.key='integration:agentmail'
        WHERE g.id=${id} AND g.owner=${owner}`;
    return row;
}
/**
 * Verify the device credential and optional generation under the account and device locks.
 * @param query - Owning transaction with no previously acquired device or command locks.
 * @param token - Private computer credential.
 * @param connectionId - Optional exact live connection generation.
 * @returns Locked device identity, never credentials or run content.
 */
export async function requireComputerDevice(
    query: TransactionSQL,
    token: string,
    connectionId?: string
) {
    const credential = readComputerCredential(token, "device");
    if (!credential)
        throw new MiraFailure("FORBIDDEN", "Computer credential is invalid or expired.");
    // Read owner before locking; every subsequent credential and generation check is repeated under the row lock.
    const [identity] = await query<
        { owner: string }[]
    >`SELECT owner FROM mira_computers WHERE id=${credential.id} AND credential_digest=${credential.digest}`;
    if (!identity)
        throw new MiraFailure("FORBIDDEN", "Computer credential is invalid or expired.");
    await lockComputerOwner(query, identity.owner);
    const [row] = await query<
        { id: string; owner: string }[]
    >`SELECT id,owner FROM mira_computers WHERE id=${credential.id} AND owner=${identity.owner} AND credential_digest=${credential.digest}
        AND state='paired' AND expires_at>clock_timestamp()
        AND (${connectionId ?? null}::uuid IS NULL OR (connection_id=${connectionId ?? null} AND connection_expires_at>clock_timestamp())) FOR UPDATE`;
    if (!row)
        throw new MiraFailure("FORBIDDEN", "Computer connection is invalid or expired.");
    return row;
}
