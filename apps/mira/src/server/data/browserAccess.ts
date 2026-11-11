import { randomUUID } from "node:crypto";

import {
    connectedBrowserScope,
    internetBrowserScope,
    miraBrowserAccessRequestSchema,
    miraBrowserAccessStopSchema,
    type MiraBrowserAccessSummary,
    publicBrowserScope,
    unrestrictedBrowserSites,
} from "@homelab/contracts/miraBrowser";
import type { TransactionSQL } from "bun";
import * as v from "valibot";

import { browserWorkerGrant } from "../browsing/wire";
import { browserNetworkForOwner } from "../config/environment";
import { miraRunPermission } from "./approvalPolicy";
import { retireBrowserCommands } from "./browserRetirement";
import {
    auditMira,
    type MiraContext,
    MiraFailure,
    type MiraQuery,
    miraTransaction,
} from "./context";

/**
 * Validate a human-selected profile inside the same owner lock as grant admission.
 * @returns Completion only for an active owned profile whose sites include the requested origins.
 */
async function requireBrowserProfile(
    query: TransactionSQL,
    owner: string,
    id: string,
    origins: string[],
    homeNetwork: boolean
) {
    const [profile] = await query<
        { origins: string[] }[]
    >`SELECT origins FROM mira_browser_profiles WHERE id=${id} AND owner=${owner} AND home_network=${homeNetwork} AND state='active'`;
    if (!profile || origins.some((origin) => !profile.origins.includes(origin)))
        throw new MiraFailure(
            "FORBIDDEN",
            "Choose an available owned profile and only its approved websites."
        );
}

type Policy = Pick<
    ReturnType<typeof browserWorkerGrant>,
    "origins" | "initialUrl" | "mode"
> & { connected?: true };
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
    controller: "mira" | "human";
    validForMs: number;
}
function human(context: MiraContext) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Browser access requires a signed-in operator."
        );
}
/**
 * Serialize browser controls with the account's other human grants.
 * @param query - Owning transaction.
 * @param owner - Verified account identity.
 * @returns Completion once concurrent grant changes are excluded.
 */
export async function lockBrowserOwner(query: TransactionSQL, owner: string) {
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
/**
 * Read private grant authority for trusted host and command boundaries.
 * @param query - Product connection or transaction holding the owner lock for mutations.
 * @param owner - Verified account.
 * @param id - Exact grant identity.
 * @returns Current authority, including private host identity; never expose this through an API.
 */
export async function readBrowserAccess(
    query: MiraQuery,
    owner: string,
    id: string
): Promise<AccessRow | undefined> {
    const [row] = await query<AccessRow[]>`
        SELECT g.id,g.run_id AS "runId",g.run_lease AS "runLease",g.mode,g.state,g.host_token AS "hostToken",(g.policy - 'delegatedMode') AS policy,g.expires_at AS "expiresAt",coalesce(console.controller,'mira') AS controller,
            (g.state IN ('pending','active') AND g.expires_at>clock_timestamp() AND r.manual
                AND (NOT (g.policy ? 'connected') OR (r.automation_id IS NULL AND NOT (g.policy ? 'delegatedMode') AND ${browserNetworkForOwner(owner)}))
                AND r.state='running' AND NOT r.cancel_requested AND r.lease_token=g.run_lease
                AND r.lease_expires_at>clock_timestamp() AND (r.budget_seconds=0 OR r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp())
                AND c.deleted_at IS NULL AND coalesce(u.enabled,true) AND b.enabled
                AND (r.automation_id IS NULL OR (a.deleted_at IS NULL AND s.enabled AND
                    (a.schedule->>'event' IS DISTINCT FROM 'agentmail' OR i.enabled)))
                AND (NOT (g.policy ? 'delegatedMode') OR (
                    r.approval_revoked_at IS NULL AND r.automation_id IS NULL AND r.task_id IS NULL AND c.archived_at IS NULL
                    AND g.policy->>'delegatedMode'=r.settings->>'permissionMode'
                    AND c.settings->>'permissionMode'=r.settings->>'permissionMode'))
                AND g.controls=jsonb_build_array(coalesce(u.version,1),b.version,a.version,s.version,
                    CASE WHEN a.schedule->>'event'='agentmail' THEN i.version END)) IS TRUE AS available,
            greatest(0,least(5000,floor(extract(epoch FROM (least(g.expires_at,r.lease_expires_at,
                r.started_at+nullif(r.budget_seconds,0)*interval '1 second')-clock_timestamp()))*1000)))::int AS "validForMs"
        FROM mira_browser_access g JOIN mira_runs r ON r.id=g.run_id AND r.owner=g.owner
        JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=g.owner
        LEFT JOIN mira_browser_consoles console ON console.access_id=g.id
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
    return reserveBrowserAccess(
        context,
        v.parse(miraBrowserAccessRequestSchema, input),
        false
    );
}

/** Start a temporary public browser within the current Chat permission and executor lease.
 * @param context - Fenced tool actor. The database supplies all permission and ownership decisions.
 * @param initialUrl - Requested document.
 * @param network - Separate browsing session requested for this task.
 * @returns Browser status, or a request for manual approval in Ask mode.
 */
export async function requestPublicBrowser(
    context: MiraContext,
    initialUrl: string,
    network: "public" | "home" = "public"
) {
    if (!context.run || context.actor !== `mira:${context.run.id}`)
        throw new MiraFailure("FORBIDDEN", "A running chat is required.");
    return reserveBrowserAccess(
        context,
        {
            runId: context.run.id,
            initialUrl,
            origins: [publicBrowserScope],
            network,
            mode: "view",
        },
        true
    );
}

async function reserveBrowserAccess(
    context: MiraContext,
    request: v.InferOutput<typeof miraBrowserAccessRequestSchema>,
    delegated: boolean
): Promise<MiraBrowserAccessSummary> {
    let policy: Policy;
    try {
        const installed = browserNetworkForOwner(context.owner);
        const connected = request.network === "home";
        if (connected && !installed)
            throw new Error("Home browsing is not configured for this account.");
        if (
            request.origins.some(
                (x) => x === connectedBrowserScope || x === internetBrowserScope
            )
        )
            throw new Error("The network is selected by the server.");
        const parsed = browserWorkerGrant({
            origins:
                installed && request.network && unrestrictedBrowserSites(request.origins)
                    ? [connected ? connectedBrowserScope : internetBrowserScope]
                    : request.origins,
            initialUrl: request.initialUrl,
            mode: request.mode,
        });
        policy = {
            origins: parsed.origins,
            initialUrl: parsed.initialUrl,
            mode: parsed.mode,
            ...(connected ? { connected: true as const } : {}),
        };
    } catch {
        throw new MiraFailure(
            "BAD_REQUEST",
            "Choose a public HTTP(S) URL or a starting URL within the selected websites."
        );
    }
    return context.client.begin(async (query) => {
        await lockBrowserOwner(query, context.owner);
        let delegatedMode;
        if (delegated) {
            delegatedMode = await miraRunPermission(query, context);
            const [previousGrant] = await query<
                { id: string }[]
            >`SELECT id FROM mira_browser_access WHERE owner=${context.owner} AND run_id=${request.runId} ORDER BY created_at DESC LIMIT 1`;
            if (previousGrant) {
                const existing = await readBrowserAccess(
                    query,
                    context.owner,
                    previousGrant.id
                );
                if (
                    existing?.available &&
                    existing.runLease === context.run?.leaseToken
                ) {
                    if (Boolean(existing.policy?.connected) !== Boolean(policy.connected))
                        throw new MiraFailure(
                            "PRECONDITION_FAILED",
                            "This browser is on the other network. Start a separate session in Chat."
                        );
                    return summary(existing);
                }
                throw new MiraFailure(
                    "FORBIDDEN",
                    "Browser access ended for this run. The operator can grant a new session."
                );
            }
            if (policy.connected)
                throw new MiraFailure(
                    "FORBIDDEN",
                    "Ask the operator to grant Home network access in Chat for this run."
                );
            if (delegatedMode === "ask")
                throw new MiraFailure(
                    "FORBIDDEN",
                    "Ask the operator to allow Browser access in Chat."
                );
            policy.mode = delegatedMode === "full_access" ? "control" : "view";
        }
        if (request.profileId && unrestrictedBrowserSites(policy.origins))
            throw new MiraFailure(
                "BAD_REQUEST",
                "Saved profiles require specific websites."
            );
        if (request.profileId)
            await requireBrowserProfile(
                query,
                context.owner,
                request.profileId,
                policy.origins,
                Boolean(policy.connected)
            );
        const previous = await query<
            { id: string }[]
        >`SELECT id FROM mira_browser_access WHERE owner=${context.owner} AND state='pending'`;
        for (const item of previous) {
            const row = await readBrowserAccess(query, context.owner, item.id);
            if (!row?.available)
                await retireBrowserCommands(query, context.owner, item.id);
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
            SELECT r.lease_token AS lease,least(clock_timestamp()+interval '5 minutes',r.started_at+nullif(r.budget_seconds,0)*interval '1 second') AS "expiresAt",
                jsonb_build_array(coalesce(u.version,1),b.version,a.version,s.version,CASE WHEN a.schedule->>'event'='agentmail' THEN i.version END) AS controls
            FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
            LEFT JOIN mira_switches u ON u.owner=r.owner AND u.key='autonomy'
            LEFT JOIN mira_switches b ON b.owner=r.owner AND b.key='computer:browser'
            LEFT JOIN mira_automations a ON a.id=r.automation_id AND a.owner=r.owner
            LEFT JOIN mira_switches s ON s.owner=r.owner AND s.key='automation:'||a.id::text
            LEFT JOIN mira_switches i ON i.owner=r.owner AND i.key='integration:agentmail'
            WHERE r.id=${request.runId} AND r.owner=${context.owner} AND r.manual AND r.state='running' AND NOT r.cancel_requested
                AND r.lease_expires_at>clock_timestamp() AND (r.budget_seconds=0 OR r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp())
                AND (NOT ${Boolean(policy.connected)} OR r.automation_id IS NULL)
                AND (NOT ${delegated} OR (r.lease_token=${context.run?.leaseToken ?? null} AND r.automation_id IS NULL AND r.task_id IS NULL AND r.approval_revoked_at IS NULL AND r.settings->>'permissionMode'=${delegatedMode ?? null} AND c.settings->>'permissionMode'=${delegatedMode ?? null} AND c.archived_at IS NULL))
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
            INSERT INTO mira_browser_access(id,owner,run_id,run_lease,controls,mode,policy,profile_id,expires_at,created_at)
            SELECT ${id},${context.owner},${request.runId},${run.lease},${JSON.stringify(run.controls)}::text::jsonb,${policy.mode},${JSON.stringify({ ...policy, ...(delegatedMode ? { delegatedMode } : {}) })}::text::jsonb,${request.profileId ?? null},
                least(${run.expiresAt}::timestamptz,timing.at+interval '5 minutes'),timing.at FROM timing WHERE ${run.expiresAt}::timestamptz>timing.at RETURNING id`;
        if (!inserted)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "The browser job expired before access could be granted."
            );
        await query`INSERT INTO mira_browser_consoles(access_id,epoch) VALUES(${id},${crypto.randomUUID()})`;
        await auditMira(query, context, "browser.access_requested", id);
        return summary((await readBrowserAccess(query, context.owner, id))!);
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
        const row = await readBrowserAccess(context.client, context.owner, item.id);
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
        await lockBrowserOwner(query, context.owner);
        const [row] = await query<
            { id: string }[]
        >`UPDATE mira_browser_access SET state=CASE WHEN state='pending' THEN 'closed' ELSE 'stopping' END,
            closed_at=CASE WHEN state='pending' THEN clock_timestamp() ELSE NULL END,policy=NULL
            WHERE id=${id} AND owner=${context.owner} AND state IN ('pending','active') RETURNING id`;
        if (row) {
            await retireBrowserCommands(query, context.owner, id);
            await auditMira(query, context, "browser.access_stopped", id);
        }
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
    return miraTransaction(context, async (query) => {
        await lockBrowserOwner(query, context.owner);
        const row = await readBrowserAccess(query, context.owner, id);
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
        await lockBrowserOwner(query, context.owner);
        const row = await readBrowserAccess(query, context.owner, input.id);
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
        await lockBrowserOwner(query, context.owner);
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
