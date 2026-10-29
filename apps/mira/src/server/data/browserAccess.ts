import { randomUUID } from "node:crypto";

import {
    miraBrowserAccessRequestSchema,
    miraBrowserAccessStopSchema,
    type MiraBrowserAccessSummary,
} from "@homelab/contracts/miraBrowser";
import type { TransactionSQL } from "bun";
import * as v from "valibot";

import { browserWorkerGrant } from "../browsing/wire";
import {
    auditMira,
    MiraFailure,
    miraTransaction,
    type MiraContext,
    type MiraQuery,
} from "./context";

type Policy = Pick<
    ReturnType<typeof browserWorkerGrant>,
    "origins" | "initialUrl" | "mode"
>;
interface AccessRow {
    id: string;
    runId: string;
    runLease: string;
    mode: "view" | "control";
    state: "pending" | "active" | "stopping" | "closed";
    hostToken: string | null;
    policy: Policy | null;
    expiresAt: Date;
    available: boolean;
    validForMs: number;
}
function human(context: MiraContext) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Browser access requires a signed-in operator."
        );
}
async function lockOwner(query: TransactionSQL, owner: string) {
    await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${owner}`},0))`;
}
function summary(row: AccessRow): MiraBrowserAccessSummary {
    return {
        id: row.id,
        runId: row.runId,
        mode: row.mode,
        state:
            (row.state === "pending" || row.state === "active") && !row.available
                ? "unavailable"
                : row.state,
        expiresAt: row.expiresAt.toISOString(),
        origins: row.policy?.origins ?? [],
        initialUrl: row.policy?.initialUrl ?? null,
    };
}
async function readAccess(
    query: MiraQuery,
    owner: string,
    id: string
): Promise<AccessRow | undefined> {
    const [row] = await query<AccessRow[]>`
        SELECT g.id,g.run_id AS "runId",g.run_lease AS "runLease",g.mode,g.state,g.host_token AS "hostToken",g.policy,g.expires_at AS "expiresAt",
            (g.state IN ('pending','active') AND g.expires_at>clock_timestamp() AND r.manual
                AND r.state='running' AND NOT r.cancel_requested AND r.lease_token=g.run_lease
                AND r.lease_expires_at>clock_timestamp() AND r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp()
                AND c.deleted_at IS NULL AND coalesce(u.enabled,true) AND b.enabled
                AND (r.automation_id IS NULL OR (a.deleted_at IS NULL AND s.enabled AND
                    (a.schedule->>'event' IS DISTINCT FROM 'agentmail' OR i.enabled)))
                AND g.controls=jsonb_build_array(coalesce(u.version,1),b.version,a.version,s.version,
                    CASE WHEN a.schedule->>'event'='agentmail' THEN i.version END)) IS TRUE AS available,
            greatest(0,least(5000,floor(extract(epoch FROM (least(g.expires_at,r.lease_expires_at,
                r.started_at+r.budget_seconds*interval '1 second')-clock_timestamp()))*1000)))::int AS "validForMs"
        FROM mira_browser_access g JOIN mira_runs r ON r.id=g.run_id AND r.owner=g.owner
        JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=g.owner
        LEFT JOIN mira_switches u ON u.owner=g.owner AND u.key='autonomy'
        LEFT JOIN mira_switches b ON b.owner=g.owner AND b.key='computer:browser'
        LEFT JOIN mira_automations a ON a.id=r.automation_id AND a.owner=r.owner
        LEFT JOIN mira_switches s ON s.owner=g.owner AND s.key='automation:'||a.id::text
        LEFT JOIN mira_switches i ON i.owner=g.owner AND i.key='integration:agentmail'
        WHERE g.id=${id} AND g.owner=${owner}`;
    return row;
}

/**
 * Reserve one immutable browser policy for a running owned manual job.
 * @param context - Freshly verified human context; a model cannot create grants.
 * @param input - Exact run, approved HTTP(S) origins, initial URL and view/control mode.
 * @returns Public metadata without host tokens, worker leases or executable configuration.
 */
export async function requestMiraBrowserAccess(
    context: MiraContext,
    input: unknown
): Promise<MiraBrowserAccessSummary> {
    human(context);
    const request = v.parse(miraBrowserAccessRequestSchema, input);
    let policy: Policy;
    try {
        const parsed = browserWorkerGrant({
            origins: request.origins,
            initialUrl: request.initialUrl,
            mode: request.mode,
        });
        policy = {
            origins: parsed.origins,
            initialUrl: parsed.initialUrl,
            mode: parsed.mode,
        };
    } catch {
        throw new MiraFailure(
            "BAD_REQUEST",
            "Choose unique exact HTTP(S) origins and a URL within them, without credentials."
        );
    }
    return context.client.begin(async (query) => {
        await lockOwner(query, context.owner);
        const previous = await query<
            { id: string }[]
        >`SELECT id FROM mira_browser_access WHERE owner=${context.owner} AND state='pending'`;
        for (const item of previous) {
            const row = await readAccess(query, context.owner, item.id);
            if (!row?.available)
                await query`UPDATE mira_browser_access SET state='closed',closed_at=clock_timestamp(),policy=NULL WHERE id=${item.id} AND state='pending'`;
        }
        const [limits] = await query<{ busy: boolean; recent: number }[]>`
            SELECT coalesce(bool_or(state<>'closed'),false) AS busy,count(*) FILTER(WHERE created_at>clock_timestamp()-interval '1 hour')::int AS recent
            FROM mira_browser_access WHERE owner=${context.owner}`;
        if (limits!.busy || limits!.recent >= 20)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Stop and finish browser cleanup before requesting another session, or wait for the request limit."
            );
        const [run] = await query<
            { lease: string; expiresAt: Date; controls: unknown }[]
        >`
            SELECT r.lease_token AS lease,least(clock_timestamp()+interval '5 minutes',r.started_at+r.budget_seconds*interval '1 second') AS "expiresAt",
                jsonb_build_array(coalesce(u.version,1),b.version,a.version,s.version,CASE WHEN a.schedule->>'event'='agentmail' THEN i.version END) AS controls
            FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
            LEFT JOIN mira_switches u ON u.owner=r.owner AND u.key='autonomy'
            LEFT JOIN mira_switches b ON b.owner=r.owner AND b.key='computer:browser'
            LEFT JOIN mira_automations a ON a.id=r.automation_id AND a.owner=r.owner
            LEFT JOIN mira_switches s ON s.owner=r.owner AND s.key='automation:'||a.id::text
            LEFT JOIN mira_switches i ON i.owner=r.owner AND i.key='integration:agentmail'
            WHERE r.id=${request.runId} AND r.owner=${context.owner} AND r.manual AND r.state='running' AND NOT r.cancel_requested
                AND r.lease_expires_at>clock_timestamp() AND r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp()
                AND c.deleted_at IS NULL AND coalesce(u.enabled,true) AND b.enabled
                AND (r.automation_id IS NULL OR (a.deleted_at IS NULL AND s.enabled AND
                    (a.schedule->>'event' IS DISTINCT FROM 'agentmail' OR i.enabled))) FOR SHARE OF r`;
        if (!run)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Enable browser access and choose a running owned manual job."
            );
        const id = Bun.randomUUIDv7();
        const [inserted] = await query<{ id: string }[]>`
            WITH timing AS MATERIALIZED(SELECT clock_timestamp() AS at)
            INSERT INTO mira_browser_access(id,owner,run_id,run_lease,controls,mode,policy,expires_at,created_at)
            SELECT ${id},${context.owner},${request.runId},${run.lease},${JSON.stringify(run.controls)}::text::jsonb,${request.mode},${JSON.stringify(policy)}::text::jsonb,
                least(${run.expiresAt}::timestamptz,timing.at+interval '5 minutes'),timing.at FROM timing WHERE ${run.expiresAt}::timestamptz>timing.at RETURNING id`;
        if (!inserted)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "The browser job expired before access could be granted."
            );
        await auditMira(query, context, "browser.access_requested", id);
        return summary((await readAccess(query, context.owner, id))!);
    });
}

/**
 * List recent owned browser grants without executor lease or host-token disclosure.
 * @param context - Signed-in human context.
 * @param runId - Optional exact run filter.
 * @returns At most fifty effective grant summaries.
 */
export async function listMiraBrowserAccess(
    context: MiraContext,
    runId?: string
): Promise<MiraBrowserAccessSummary[]> {
    human(context);
    if (runId) v.parse(v.pipe(v.string(), v.uuid()), runId);
    const rows = await context.client<
        { id: string }[]
    >`SELECT id FROM mira_browser_access WHERE owner=${context.owner} AND (${runId ?? null}::uuid IS NULL OR run_id=${runId ?? null}::uuid) ORDER BY created_at DESC,id DESC LIMIT 50`;
    const result: MiraBrowserAccessSummary[] = [];
    for (const item of rows) {
        const row = await readAccess(context.client, context.owner, item.id);
        if (row) result.push(summary(row));
    }
    return result;
}

/**
 * Revoke access immediately without claiming that an already started browser has stopped.
 * @param context - Signed-in human; a new MFA challenge is not required for stopping.
 * @param input - Owned grant identity.
 * @returns Completion; active grants remain reserved until trusted host cleanup is confirmed.
 */
export async function stopMiraBrowserAccess(
    context: MiraContext,
    input: unknown
): Promise<void> {
    human(context);
    const { id } = v.parse(miraBrowserAccessStopSchema, input);
    await context.client.begin(async (query) => {
        await lockOwner(query, context.owner);
        const [row] = await query<
            { id: string }[]
        >`UPDATE mira_browser_access SET state=CASE WHEN state='pending' THEN 'closed' ELSE 'stopping' END,
            closed_at=CASE WHEN state='pending' THEN clock_timestamp() ELSE NULL END,policy=NULL
            WHERE id=${id} AND owner=${context.owner} AND state IN ('pending','active') RETURNING id`;
        if (row) await auditMira(query, context, "browser.access_stopped", id);
    });
}

/**
 * Consume a human grant once for the exact executor lease before starting a browser.
 * @param context - Trusted supervisor's current run context; never model-selected identity.
 * @param id - Exact grant identity.
 * @returns Private host token and immutable policy; never serialize the token to Chat or human APIs.
 */
export async function claimMiraBrowserAccess(context: MiraContext, id: string) {
    v.parse(v.pipe(v.string(), v.uuid()), id);
    if (!context.run)
        throw new MiraFailure("FORBIDDEN", "Browser execution requires an active run.");
    return context.client.begin(async (query) => {
        await lockOwner(query, context.owner);
        const row = await readAccess(query, context.owner, id);
        if (
            !row?.available ||
            row.state !== "pending" ||
            row.runId !== context.run!.id ||
            row.runLease !== context.run!.leaseToken ||
            row.validForMs <= 0 ||
            !row.policy
        )
            throw new MiraFailure(
                "FORBIDDEN",
                "Browser access is no longer available for this run."
            );
        const hostToken = randomUUID();
        await query`UPDATE mira_browser_access SET state='active',host_token=${hostToken},claimed_at=clock_timestamp() WHERE id=${id}`;
        return {
            id,
            hostToken,
            policy: row.policy,
            expiresAt: row.expiresAt.toISOString(),
        };
    });
}

/**
 * Recheck the immutable host claim, run lease, control generations and action scope.
 * @param context - Trusted supervisor's current executor context.
 * @param input - Private host token and required view/control scope.
 * @returns At most five seconds of authority; the host must check after work and never replay input.
 */
export async function requireMiraBrowserAccess(
    context: MiraContext,
    input: { id: string; hostToken: string; mode: "view" | "control" }
) {
    v.parse(
        v.strictObject({
            id: v.pipe(v.string(), v.uuid()),
            hostToken: v.pipe(v.string(), v.uuid()),
            mode: v.picklist(["view", "control"]),
        }),
        input
    );
    if (!context.run)
        throw new MiraFailure("FORBIDDEN", "Browser execution requires an active run.");
    return miraTransaction(context, async (query) => {
        await lockOwner(query, context.owner);
        const row = await readAccess(query, context.owner, input.id);
        if (
            !row?.available ||
            row.state !== "active" ||
            row.runId !== context.run!.id ||
            row.runLease !== context.run!.leaseToken ||
            row.hostToken !== input.hostToken ||
            (input.mode === "control" && row.mode !== "control") ||
            row.validForMs <= 0
        )
            throw new MiraFailure(
                "FORBIDDEN",
                "Browser access is no longer available for this action."
            );
        return { validForMs: row.validForMs };
    });
}

/**
 * Release a claimed slot only after the trusted host has proved container absence.
 * @param context - Supervisor context retaining the original owner and run lease even after cancellation.
 * @param input - Exact private claim token; human and model endpoints never expose this operation.
 * @returns Idempotent completion; a wrong claim cannot unblock replacement.
 */
export async function closeMiraBrowserAccess(
    context: MiraContext,
    input: { id: string; hostToken: string }
): Promise<void> {
    v.parse(
        v.strictObject({
            id: v.pipe(v.string(), v.uuid()),
            hostToken: v.pipe(v.string(), v.uuid()),
        }),
        input
    );
    if (!context.run)
        throw new MiraFailure(
            "FORBIDDEN",
            "Browser cleanup requires its original host claim."
        );
    await miraTransaction(context, async (query) => {
        await lockOwner(query, context.owner);
        const live = await query<
            { id: string }[]
        >`SELECT p.id FROM mira_browser_processes p JOIN mira_browser_access g ON g.id=p.access_id WHERE p.access_id=${input.id} AND p.state<>'removed' AND g.owner=${context.owner} AND g.run_id=${context.run!.id} AND g.run_lease=${context.run!.leaseToken} AND g.host_token=${input.hostToken}`;
        if (live.length > 0)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Browser process cleanup must be confirmed first."
            );
        const [row] = await query<
            { id: string }[]
        >`UPDATE mira_browser_access SET state='closed',closed_at=clock_timestamp(),policy=NULL
            WHERE id=${input.id} AND owner=${context.owner} AND run_id=${context.run!.id} AND run_lease=${context.run!.leaseToken}
                AND host_token=${input.hostToken} AND state IN ('active','stopping') RETURNING id`;
        if (row)
            await auditMira(
                query,
                { owner: context.owner, actor: "browser:cleanup" },
                "browser.access_closed",
                input.id
            );
    });
}
