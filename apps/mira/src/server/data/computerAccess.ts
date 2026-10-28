import {
    miraComputerAccessAcceptSchema,
    miraComputerAccessConnectionSchema,
    miraComputerAccessRequestSchema,
    miraComputerAccessPermitSchema,
    miraComputerAccessStopSchema,
    type MiraComputerAccessSummary,
} from "@homelab/contracts/miraComputers";
import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import {
    lockComputerOwner as lockOwner,
    readComputerAccess as readAccess,
    requireComputerDevice as device,
    type AccessRow,
} from "./computerAuthority";
import { retireComputerCommands } from "./computerCommands";
import { auditMira, MiraFailure, type MiraContext } from "./context";

function human(context: MiraContext) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Computer access requires a signed-in operator."
        );
}
function summary(row: AccessRow): MiraComputerAccessSummary {
    let state: MiraComputerAccessSummary["state"] = row.state;
    if (state !== "stopped") {
        if (row.expired) state = "expired";
        else if (!row.available) state = "unavailable";
    }
    return {
        id: row.id,
        computerId: row.computerId,
        runId: row.runId,
        mode: row.mode,
        state,
        expiresAt: row.expiresAt.toISOString(),
    };
}

/**
 * Request one short-lived computer session for an already running owned job.
 * @param context - Freshly reverified human; this function never accepts a model principal.
 * @param input - Displayed computer version, exact run and view-only or input authority.
 * @returns Pending local consent, never an executable or an active desktop capability.
 */
export async function requestMiraComputerAccess(
    context: MiraContext,
    input: unknown
): Promise<MiraComputerAccessSummary> {
    human(context);
    const request = v.parse(miraComputerAccessRequestSchema, input);
    return context.client.begin(async (query) => {
        await lockOwner(query, context.owner);
        const [computer] = await query<{ connectionId: string; expiresAt: Date }[]>`
            SELECT connection_id AS "connectionId",expires_at AS "expiresAt" FROM mira_computers
            WHERE id=${request.computerId} AND owner=${context.owner} AND version=${request.computerVersion}
            AND state='paired' AND expires_at>clock_timestamp() AND connection_expires_at>clock_timestamp() FOR UPDATE`;
        if (!computer)
            throw new MiraFailure(
                "CONFLICT",
                "Computer changed or is offline. Refresh before allowing access."
            );
        // Retire unusable requests before enforcing the one-computer/one-run ceiling.
        const previous = await query<
            { id: string }[]
        >`SELECT id FROM mira_computer_access WHERE owner=${context.owner} AND state IN ('pending','active')`;
        for (const item of previous) {
            const current = await readAccess(query, context.owner, item.id);
            if (!current?.available)
                await query`UPDATE mira_computer_access SET state='stopped',stopped_at=clock_timestamp() WHERE id=${item.id}`;
        }
        const [limits] = await query<{ busy: boolean; recent: number }[]>`
            SELECT coalesce(bool_or(state IN ('pending','active') AND (computer_id=${request.computerId} OR run_id=${request.runId})),false) AS busy,
            count(*) FILTER(WHERE created_at>clock_timestamp()-interval '1 hour')::int AS recent
            FROM mira_computer_access WHERE owner=${context.owner}`;
        if (limits!.busy || limits!.recent >= 20)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Computer access is already pending or active, or its request limit was reached."
            );
        const [run] = await query<
            { lease: string; expiresAt: Date; controls: unknown }[]
        >`
            SELECT r.lease_token AS lease,least(clock_timestamp()+interval '5 minutes',r.started_at+r.budget_seconds*interval '1 second',${computer.expiresAt}) AS "expiresAt",
                jsonb_build_array(coalesce(u.version,1),a.version,s.version,CASE WHEN a.schedule->>'event'='agentmail' THEN i.version END) AS controls
            FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
            LEFT JOIN mira_switches u ON u.owner=r.owner AND u.key='autonomy'
            LEFT JOIN mira_automations a ON a.id=r.automation_id AND a.owner=r.owner
            LEFT JOIN mira_switches s ON s.owner=r.owner AND s.key='automation:'||a.id::text
            LEFT JOIN mira_switches i ON i.owner=r.owner AND i.key='integration:agentmail'
            WHERE r.id=${request.runId} AND r.owner=${context.owner} AND r.state='running' AND NOT r.cancel_requested
                AND r.lease_expires_at>clock_timestamp() AND r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp()
                AND c.deleted_at IS NULL AND coalesce(u.enabled,true)
                AND (r.automation_id IS NULL OR (a.deleted_at IS NULL AND s.enabled AND
                    (a.schedule->>'event' IS DISTINCT FROM 'agentmail' OR i.enabled))) FOR SHARE OF r`;
        if (!run)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "The selected run is no longer available for computer access."
            );
        const id = Bun.randomUUIDv7();
        const [inserted] = await query<{ id: string }[]>`
            WITH timing AS MATERIALIZED (SELECT clock_timestamp() AS at)
            INSERT INTO mira_computer_access(id,owner,computer_id,computer_version,connection_id,run_id,run_lease,controls,mode,expires_at,created_at)
            SELECT ${id},${context.owner},${request.computerId},${request.computerVersion},${computer.connectionId},${request.runId},${run.lease},${JSON.stringify(run.controls)}::text::jsonb,${request.mode},
                least(${run.expiresAt}::timestamptz,timing.at+interval '5 minutes'),timing.at
            FROM timing WHERE ${run.expiresAt}::timestamptz>timing.at RETURNING id`;
        if (!inserted)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Computer access expired before it could be requested."
            );
        await auditMira(query, context, "computer.access_requested", id);
        return summary((await readAccess(query, context.owner, id))!);
    });
}

/**
 * Read recent owned access requests with effective expiry and cancellation state.
 * @param context - Signed-in operator, never a machine or model.
 * @returns At most fifty summaries without run lease tokens, device secrets or window details.
 */
export async function listMiraComputerAccess(
    context: MiraContext
): Promise<MiraComputerAccessSummary[]> {
    human(context);
    const rows = await context.client<
        { id: string }[]
    >`SELECT id FROM mira_computer_access WHERE owner=${context.owner} ORDER BY created_at DESC,id DESC LIMIT 50`;
    const result: MiraComputerAccessSummary[] = [];
    for (const item of rows) {
        const row = await readAccess(context.client, context.owner, item.id);
        if (row) result.push(summary(row));
    }
    return result;
}

/**
 * Discover the single pending consent request on this exact live companion connection.
 * @param client - Product database; callers use the private machine listener.
 * @param token - Computer-only credential, never a browser session.
 * @param input - Current connection generation.
 * @returns Metadata for a local consent prompt, without chat content or input commands.
 */
export async function pendingMiraComputerAccess(
    client: SQL,
    token: string,
    input: unknown
) {
    const { connectionId } = v.parse(miraComputerAccessConnectionSchema, input);
    return client.begin(async (query) => {
        const computer = await device(query, token, connectionId);
        const [candidate] = await query<
            { id: string }[]
        >`SELECT id FROM mira_computer_access WHERE computer_id=${computer.id} AND owner=${computer.owner} AND connection_id=${connectionId} AND state='pending' LIMIT 1`;
        const row = candidate
            ? await readAccess(query, computer.owner, candidate.id)
            : undefined;
        return {
            request: row?.available
                ? {
                      ...summary(row),
                      consentExpiresAt: row.consentExpiresAt.toISOString(),
                  }
                : null,
        };
    });
}

/**
 * Consume local consent once for an immutable target selected on the paired PC.
 * @param client - Product database.
 * @param token - Device credential for the same current connection as the human's request.
 * @param input - Exact request and locally generated target ID; paths, PIDs and screenshots stay local.
 * @returns Bound session metadata; the companion must still enforce OS readiness and short per-action permits.
 */
export async function acceptMiraComputerAccess(
    client: SQL,
    token: string,
    input: unknown
) {
    const accepted = v.parse(miraComputerAccessAcceptSchema, input);
    return client.begin(async (query) => {
        const computer = await device(query, token, accepted.connectionId);
        const row = await readAccess(query, computer.owner, accepted.id);
        if (
            !row?.available ||
            row.computerId !== computer.id ||
            row.connectionId !== accepted.connectionId ||
            row.state !== "pending"
        )
            throw new MiraFailure(
                "FORBIDDEN",
                "Computer access is no longer awaiting local consent."
            );
        await query`UPDATE mira_computer_access SET state='active',target_id=${accepted.targetId},accepted_at=clock_timestamp() WHERE id=${row.id}`;
        await auditMira(
            query,
            { owner: computer.owner, actor: `computer:${computer.id}` },
            "computer.access_accepted",
            row.id
        );
        return summary((await readAccess(query, computer.owner, row.id))!);
    });
}

async function stop(
    query: TransactionSQL,
    context: Pick<MiraContext, "owner" | "actor">,
    id: string,
    computerId?: string
) {
    const [row] = await query<
        { id: string }[]
    >`UPDATE mira_computer_access SET state='stopped',stopped_at=clock_timestamp()
        WHERE id=${id} AND owner=${context.owner} AND state<>'stopped' AND (${computerId ?? null}::uuid IS NULL OR computer_id=${computerId ?? null}) RETURNING id`;
    if (row) {
        await retireComputerCommands(query, context.owner, id);
        await auditMira(query, context, "computer.access_stopped", id);
    }
}
/**
 * Stop one owned session idempotently without requiring a new MFA challenge.
 * @param context - Signed-in operator; stopping never creates or resumes authority.
 * @param input - Exact request identity, without optimistic versions that could obstruct stop.
 * @returns Completion after durable denial; in-flight input outcomes still require companion reconciliation.
 */
export async function stopMiraComputerAccess(
    context: MiraContext,
    input: unknown
): Promise<void> {
    human(context);
    const { id } = v.parse(miraComputerAccessStopSchema, input);
    await context.client.begin(async (query) => {
        await lockOwner(query, context.owner);
        await stop(query, context, id);
    });
}
/**
 * Record local stop or manual takeover even if the old connection generation has ended.
 * @param client - Product database.
 * @param token - Still-valid paired computer credential.
 * @param input - Session identity; the PC must close its native session before making this request.
 * @returns Completion without revealing or changing another computer's sessions.
 */
export async function stopMiraComputerAccessLocally(
    client: SQL,
    token: string,
    input: unknown
): Promise<void> {
    const { id } = v.parse(miraComputerAccessStopSchema, input);
    await client.begin(async (query) => {
        const computer = await device(query, token);
        await stop(
            query,
            { owner: computer.owner, actor: `computer:${computer.id}` },
            id,
            computer.id
        );
    });
}

/**
 * Recheck the exact worker lease, owner, connection, target, controls and action scope.
 * @param context - Current executor run, never model-supplied owner or lease material.
 * @param input - Session and immutable local target, with the required action scope.
 * @returns A maximum five-second dispatch ceiling; callers check again after work and never replay uncertain input.
 */
export async function requireMiraComputerAccess(
    context: MiraContext,
    input: { id: string; targetId: string; mode: "view" | "control" }
) {
    if (!context.run)
        throw new MiraFailure("FORBIDDEN", "Computer access requires an active run.");
    return context.client.begin(async (query) => {
        await lockOwner(query, context.owner);
        const row = await readAccess(query, context.owner, input.id);
        if (
            !row?.available ||
            row.state !== "active" ||
            row.runId !== context.run!.id ||
            row.runLease !== context.run!.leaseToken ||
            row.targetId !== input.targetId ||
            (input.mode === "control" && row.mode !== "control") ||
            row.validForMs <= 0
        )
            throw new MiraFailure(
                "FORBIDDEN",
                "Computer access is stopped, expired or no longer available."
            );
        return {
            id: row.id,
            connectionId: row.connectionId,
            targetId: row.targetId,
            mode: row.mode,
            validForMs: row.validForMs,
        };
    });
}

/**
 * Recheck live server authority from the paired PC before and after native work.
 * @param client - Product database reached through the private machine listener.
 * @param token - Device credential for the current connection, never a run credential.
 * @param input - Exact accepted session, immutable target and requested scope.
 * @returns A bounded dispatch ceiling; the PC also enforces local consent and OS readiness.
 */
export async function permitMiraComputerAccessLocally(
    client: SQL,
    token: string,
    input: unknown
) {
    const request = v.parse(miraComputerAccessPermitSchema, input);
    return client.begin(async (query) => {
        const computer = await device(query, token, request.connectionId);
        const row = await readAccess(query, computer.owner, request.id);
        if (
            !row?.available ||
            row.state !== "active" ||
            row.computerId !== computer.id ||
            row.connectionId !== request.connectionId ||
            row.targetId !== request.targetId ||
            (request.mode === "control" && row.mode !== "control") ||
            row.validForMs <= 0
        )
            throw new MiraFailure(
                "FORBIDDEN",
                "Computer access is stopped, expired or no longer available."
            );
        return {
            id: row.id,
            connectionId: row.connectionId,
            targetId: row.targetId,
            mode: row.mode,
            validForMs: row.validForMs,
        };
    });
}
