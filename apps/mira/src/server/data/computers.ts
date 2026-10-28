import {
    miraComputerEnrollmentSchema,
    miraComputerHeartbeatSchema,
    miraComputerPairSchema,
    type MiraComputerSummary,
} from "@homelab/contracts/miraComputers";
import type { SQL } from "bun";
import * as v from "valibot";

import { issueComputerCredential, readComputerCredential } from "../computer/credentials";
import { lockComputerOwner, requireComputerDevice } from "./computerAuthority";
import { retireComputerDeviceCommands } from "./computerCommands";
import { auditMira, MiraFailure, miraTransaction, type MiraContext } from "./context";

/**
 * Create a short-lived enrollment ticket for one computer owned by a verified human.
 * @param context - Recently reverified operator, never a model or machine principal.
 * @param input - Display label; no desktop authority is granted by enrollment.
 * @returns One-time pairing material and its server-controlled expiry.
 */
export function createMiraComputerPairing(context: MiraContext, input: unknown) {
    const { label } = v.parse(miraComputerPairSchema, input);
    return miraTransaction(context, async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:computers:${context.owner}`},0))`;
        const [count] = await query<{ active: number; recent: number }[]>`
            SELECT count(*) FILTER (WHERE state <> 'revoked' AND expires_at > clock_timestamp())::int AS active,
            count(*) FILTER (WHERE created_at > clock_timestamp()-interval '1 hour')::int AS recent
            FROM mira_computers WHERE owner=${context.owner}`;
        if (!count || count.active >= 20 || count.recent >= 20)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Computer pairing limit reached. Revoke unused computers or try later."
            );
        const id = Bun.randomUUIDv7();
        const credential = issueComputerCredential("pair", id);
        const [row] = await query<{ expiresAt: Date }[]>`
            INSERT INTO mira_computers(id,owner,label,state,pair_digest,expires_at)
            VALUES(${id},${context.owner},${label},'pending',${credential.digest},clock_timestamp()+interval '10 minutes')
            RETURNING expires_at AS "expiresAt"`;
        await auditMira(query, context, "computer.pairing_created", id);
        return {
            id,
            token: credential.token,
            version: 1,
            expiresAt: row!.expiresAt.toISOString(),
        };
    });
}

/**
 * List owned computer metadata without ever returning pairing or device verifiers.
 * @param context - Signed-in operator context.
 * @returns At most fifty recent records; connected means heartbeat freshness, not control readiness.
 */
export async function listMiraComputers(
    context: MiraContext
): Promise<MiraComputerSummary[]> {
    const rows = await context.client<
        (Omit<MiraComputerSummary, "pairedAt" | "expiresAt" | "lastSeenAt"> & {
            pairedAt: Date | null;
            expiresAt: Date;
            lastSeenAt: Date | null;
        })[]
    >`
        SELECT id,label,version,state,platform,companion_version AS "companionVersion",paired_at AS "pairedAt",expires_at AS "expiresAt",last_seen_at AS "lastSeenAt",
        (state='paired' AND expires_at>clock_timestamp() AND connection_expires_at>clock_timestamp()) IS TRUE AS connected
        FROM mira_computers WHERE owner=${context.owner}
        ORDER BY (state<>'revoked' AND expires_at>clock_timestamp()) DESC,created_at DESC,id DESC LIMIT 50`;
    return rows.map((row) => ({
        ...row,
        pairedAt: row.pairedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt.toISOString(),
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    }));
}

/**
 * Permanently revoke an exact displayed enrollment or device and its connection generation.
 * @param context - Recently reverified owner.
 * @param input - Owned identity and optimistic version from the human's displayed record.
 * @returns Completion after credentials, connection and content-free audit change atomically.
 */
export async function revokeMiraComputer(
    context: MiraContext,
    input: { id: string; version: number }
): Promise<void> {
    await miraTransaction(context, async (query) => {
        await lockComputerOwner(query, context.owner);
        const rows = await query<{ id: string }[]>`
            UPDATE mira_computers SET state='revoked',version=version+1,pair_digest=NULL,credential_digest=NULL,connection_id=NULL,connection_expires_at=NULL
            WHERE id=${input.id} AND owner=${context.owner} AND version=${input.version} AND state<>'revoked' RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "Computer changed or is no longer available. Refresh before retrying."
            );
        await retireComputerDeviceCommands(query, context.owner, input.id);
        await auditMira(query, context, "computer.revoked", input.id);
    });
}

/**
 * Atomically consume one enrollment ticket and return a separate scoped credential once.
 * @param client - Shared application database, without any browser session authority.
 * @param token - One-use pairing bearer from the verified owner.
 * @param input - Companion-reported installation metadata, never an attestation of readiness.
 * @returns New device material; a lost response requires a new pairing, never replay.
 */
export async function enrollMiraComputer(client: SQL, token: string, input: unknown) {
    const metadata = v.parse(miraComputerEnrollmentSchema, input);
    const presented = readComputerCredential(token, "pair");
    if (!presented)
        throw new MiraFailure("FORBIDDEN", "Computer credential is invalid or expired.");
    const credential = issueComputerCredential("device", presented.id);
    return await client.begin(async (query) => {
        const [row] = await query<{ owner: string; expiresAt: Date }[]>`
            UPDATE mira_computers SET state='paired',pair_digest=NULL,credential_digest=${credential.digest},
                installation_id=${metadata.installationId},platform=${metadata.platform},companion_version=${metadata.version},
                version=version+1,paired_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 days'
            WHERE id=${presented.id} AND state='pending' AND pair_digest=${presented.digest} AND expires_at>clock_timestamp()
            RETURNING owner,expires_at AS "expiresAt"`;
        if (!row)
            throw new MiraFailure(
                "FORBIDDEN",
                "Computer credential is invalid or expired."
            );
        await auditMira(
            query,
            { owner: row.owner, actor: `computer:${presented.id}` },
            "computer.enrolled",
            presented.id
        );
        return {
            id: presented.id,
            credential: credential.token,
            expiresAt: row.expiresAt.toISOString(),
            controlAllowed: false as const,
        };
    });
}

/**
 * Start a new connection generation, invalidating heartbeats from any earlier connection.
 * @param client - Shared application database.
 * @param token - Computer-only bearer; it grants neither browser APIs nor input authority.
 * @returns A short-lived generation and heartbeat cadence; no input commands are issued.
 */
export async function connectMiraComputer(client: SQL, token: string) {
    const presented = readComputerCredential(token, "device");
    if (!presented)
        throw new MiraFailure("FORBIDDEN", "Computer credential is invalid or expired.");
    const connectionId = crypto.randomUUID();
    await client.begin(async (query) => {
        const device = await requireComputerDevice(query, token);
        await query`UPDATE mira_computers SET connection_id=${connectionId},sequence=0,last_seen_at=clock_timestamp(),connection_expires_at=clock_timestamp()+interval '45 seconds' WHERE id=${device.id}`;
        await retireComputerDeviceCommands(query, device.owner, device.id);
    });
    return {
        connectionId,
        heartbeatSeconds: 15,
        leaseSeconds: 45,
        controlAllowed: false as const,
    };
}

/**
 * Renew only a live connection generation using a strictly increasing sequence number.
 * @param client - Shared application database.
 * @param token - Current scoped device credential.
 * @param input - Connection generation and sequence; server time decides all expiry.
 * @returns A transport-only heartbeat receipt, never desktop readiness or input authority.
 */
export async function heartbeatMiraComputer(client: SQL, token: string, input: unknown) {
    const metadata = v.parse(miraComputerHeartbeatSchema, input);
    const presented = readComputerCredential(token, "device");
    if (!presented)
        throw new MiraFailure("FORBIDDEN", "Computer credential is invalid or expired.");
    const rows = await client<{ id: string }[]>`
        UPDATE mira_computers SET sequence=${metadata.sequence},last_seen_at=clock_timestamp(),connection_expires_at=clock_timestamp()+interval '45 seconds'
        WHERE id=${presented.id} AND state='paired' AND credential_digest=${presented.digest} AND expires_at>clock_timestamp()
          AND connection_id=${metadata.connectionId} AND sequence<${metadata.sequence} AND connection_expires_at>clock_timestamp() RETURNING id`;
    if (!rows[0])
        throw new MiraFailure(
            "FORBIDDEN",
            "Computer connection is invalid or expired. Reconnect before continuing."
        );
    return { leaseSeconds: 45, controlAllowed: false as const };
}
