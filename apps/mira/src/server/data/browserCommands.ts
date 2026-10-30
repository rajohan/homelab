import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import {
    browserCommandResult,
    browserCommandSchema,
    type BrowserCommand,
} from "../browsing/command";
import { browserUrl } from "../browsing/policy";
import { lockBrowserOwner, readBrowserAccess } from "./browserAccess";
import { retireBrowserCommands } from "./browserRetirement";
import { MiraFailure, type MiraContext } from "./context";

const uuid = v.pipe(v.string(), v.uuid());
const claimSchema = v.strictObject({ id: uuid, hostId: uuid, leaseToken: uuid });
export type BrowserCommandClaim = v.InferOutput<typeof claimSchema>;
type State = "queued" | "claimed" | "completed" | "consumed" | "refused" | "unknown";
interface CommandRow {
    id: string;
    accessId: string;
    method: BrowserCommand["method"];
    state: State;
    result: unknown;
    processId: string | null;
    processToken: string | null;
    current: boolean;
}
const toolName = (method: BrowserCommand["method"]) =>
    method === "act" ? "mira_browser_input" : `mira_browser_${method}`;
const failure = () =>
    new MiraFailure(
        "PRECONDITION_FAILED",
        "Browser access is unavailable, busy or at its command limit. Refresh before continuing."
    );
async function liveRun(query: TransactionSQL, context: MiraContext) {
    if (!context.run) throw failure();
    const [row] = await query<{ id: string }[]>`SELECT r.id FROM mira_runs r
        JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
        WHERE r.id=${context.run.id} AND r.owner=${context.owner} AND r.manual
        AND r.state='running' AND NOT r.cancel_requested AND r.lease_token=${context.run.leaseToken}
        AND r.lease_expires_at>clock_timestamp() AND r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp()
        AND c.deleted_at IS NULL FOR SHARE OF r`;
    if (!row) throw failure();
}
async function receipt(query: TransactionSQL, context: MiraContext, id: string) {
    if (!context.run) throw failure();
    const [row] = await query<
        { tool: string }[]
    >`SELECT tool FROM mira_tool_receipts WHERE id=${id} AND run_id=${context.run.id} AND state='running' FOR UPDATE`;
    if (!row) throw failure();
    return row;
}
async function processCurrent(
    query: TransactionSQL,
    row: Pick<CommandRow, "processId" | "processToken" | "accessId">
) {
    const [current] = await query<
        { id: string }[]
    >`SELECT id FROM mira_browser_processes WHERE id=${row.processId}
        AND lease_token=${row.processToken} AND access_id=${row.accessId} AND state='active' AND phase='created' AND lease_expires_at>clock_timestamp()`;
    return Boolean(current);
}
async function accessForCommand(
    query: TransactionSQL,
    context: MiraContext,
    row: Pick<CommandRow, "accessId" | "method">
) {
    const access = await readBrowserAccess(query, context.owner, row.accessId);
    return access?.available &&
        access.policy &&
        access.runId === context.run?.id &&
        access.runLease === context.run.leaseToken &&
        (row.method !== "act" || access.mode === "control")
        ? access
        : undefined;
}

async function reconcile(query: TransactionSQL, owner: string) {
    const rows = await query<
        {
            accessId: string;
            id: string;
            current: boolean;
            state: State;
            processId: string | null;
            processToken: string | null;
        }[]
    >`
        SELECT access_id AS "accessId",id,state,process_id AS "processId",process_token AS "processToken",expires_at>clock_timestamp() AS current
        FROM mira_browser_commands WHERE owner=${owner} AND state IN ('queued','claimed','completed') ORDER BY id`;
    let count = 0;
    for (const row of rows) {
        // Hold the run and receipt against executor retirement before reading authority again.
        const [binding] = await query<
            { runId: string }[]
        >`SELECT run_id AS "runId" FROM mira_browser_access WHERE id=${row.accessId}`;
        if (binding)
            await query`SELECT id FROM mira_runs WHERE id=${binding.runId} FOR SHARE`;
        const [reserved] = await query<
            { id: string }[]
        >`SELECT id FROM mira_tool_receipts WHERE id=${row.id} AND state='running' FOR SHARE`;
        const grant = await readBrowserAccess(query, owner, row.accessId);
        const [timing] = await query<
            { current: boolean }[]
        >`SELECT expires_at>clock_timestamp() AS current FROM mira_browser_commands WHERE id=${row.id}`;
        if (
            !reserved ||
            !timing?.current ||
            !grant?.available ||
            (row.state !== "queued" && !(await processCurrent(query, row)))
        ) {
            await retireBrowserCommands(query, owner, row.accessId);
            count++;
        }
    }
    return count;
}

/**
 * Clear revoked/expired browser payloads even when no host or provider is available.
 * @param client - Product database; admission bounds outstanding commands globally.
 * @returns Number of retired grants, with no page or input content logged.
 */
export async function cleanupMiraBrowserCommands(client: SQL): Promise<number> {
    const owners = await client<
        { owner: string }[]
    >`SELECT DISTINCT owner FROM mira_browser_commands WHERE state IN ('queued','claimed','completed') ORDER BY owner LIMIT 32`;
    let count = 0;
    for (const row of owners)
        count += await client.begin(async (query) => {
            await lockBrowserOwner(query, row.owner);
            return reconcile(query, row.owner);
        });
    return count;
}

/**
 * Reserve a command for an existing human grant and a server-created tool receipt.
 * @param context - Trusted original owner/run/lease, not model arguments.
 * @param receiptId - Immutable tool receipt and command identity.
 * @param input - Observation, approved navigation or single-use input.
 * @returns Identity after admission commits; no Docker or browser work happens here.
 */
export async function enqueueMiraBrowserCommand(
    context: MiraContext,
    receiptId: string,
    input: unknown
) {
    v.parse(uuid, receiptId);
    const operation = v.parse(browserCommandSchema, input);
    const result = await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:browser-command-capacity',0))`;
        await lockBrowserOwner(query, context.owner);
        await liveRun(query, context);
        const reserved = await receipt(query, context, receiptId);
        if (reserved.tool !== toolName(operation.method)) throw failure();
        await reconcile(query, context.owner);
        const [candidate] = await query<
            { id: string }[]
        >`SELECT id FROM mira_browser_access WHERE owner=${context.owner} AND run_id=${context.run!.id} AND state IN ('pending','active')`;
        const access = candidate
            ? await accessForCommand(query, context, {
                  accessId: candidate.id,
                  method: operation.method,
              })
            : undefined;
        if (!access?.policy) return null;
        if (operation.method === "navigate") {
            try {
                browserUrl(operation.url, access.policy.origins);
            } catch {
                throw new MiraFailure(
                    "BAD_REQUEST",
                    "Choose a URL within the websites already approved for this run."
                );
            }
        }
        const [limits] = await query<
            { total: number; busy: boolean; attempted: boolean; recent: number }[]
        >`SELECT
            (SELECT count(*)::int FROM mira_browser_commands WHERE state IN ('queued','claimed','completed')) AS total,
            EXISTS(SELECT 1 FROM mira_browser_commands WHERE access_id=${access.id} AND state IN ('queued','claimed','completed')) AS busy,
            EXISTS(SELECT 1 FROM mira_browser_commands WHERE id=${receiptId}) AS attempted,
            (SELECT count(*)::int FROM mira_browser_commands WHERE access_id=${access.id}) AS recent`;
        if (
            !limits ||
            limits.total >= 32 ||
            limits.busy ||
            limits.attempted ||
            limits.recent >= 64
        )
            return null;
        await query`WITH timing AS MATERIALIZED(SELECT clock_timestamp() AS at)
            INSERT INTO mira_browser_commands(id,owner,access_id,run_id,run_lease,method,payload,created_at,expires_at)
            SELECT ${receiptId},${context.owner},${access.id},${context.run!.id},${context.run!.leaseToken},${operation.method},${JSON.stringify(operation)}::text::jsonb,timing.at,timing.at+interval '100 seconds' FROM timing`;
        return { id: receiptId };
    });
    if (!result) throw failure();
    return result;
}

/**
 * Find pending work for the private host without claiming or replaying commands.
 * @param client - Trusted host connection.
 * @returns At most two candidate grants with their original executor context.
 */
export async function pendingMiraBrowsers(client: SQL) {
    return client<
        { id: string; owner: string; runId: string; runLease: string }[]
    >`SELECT g.id,g.owner,g.run_id AS "runId",g.run_lease AS "runLease"
        FROM mira_browser_access g WHERE g.state='pending' AND EXISTS(SELECT 1 FROM mira_browser_commands c WHERE c.access_id=g.id AND c.state='queued' AND c.expires_at>clock_timestamp())
        ORDER BY g.created_at,g.id LIMIT 2`;
}
async function hostContext(client: SQL, query: TransactionSQL, input: unknown) {
    const claim = v.parse(claimSchema, input);
    const [first] = await query<
        { owner: string }[]
    >`SELECT g.owner FROM mira_browser_processes p JOIN mira_browser_access g ON g.id=p.access_id WHERE p.id=${claim.id}`;
    if (!first) throw failure();
    await lockBrowserOwner(query, first.owner);
    const [row] = await query<
        { accessId: string; runId: string; runLease: string }[]
    >`SELECT p.access_id AS "accessId",g.run_id AS "runId",g.run_lease AS "runLease"
        FROM mira_browser_processes p JOIN mira_browser_access g ON g.id=p.access_id
        WHERE p.id=${claim.id} AND p.host_id=${claim.hostId} AND p.lease_token=${claim.leaseToken} AND p.state='active' AND p.phase='created' AND p.lease_expires_at>clock_timestamp()`;
    if (!row) throw failure();
    const context: MiraContext = {
        client,
        transaction: query,
        owner: first.owner,
        actor: "browser:host",
        run: { id: row.runId, leaseToken: row.runLease },
    };
    await liveRun(query, context);
    return { context, accessId: row.accessId, claim };
}

/**
 * Deliver one queued command exactly once to its current durable browser process.
 * @param client - Trusted host database.
 * @param input - Private process/controller claim from browser startup.
 * @returns A single command with its deadline, or null; committed claims are never reclaimed.
 */
export async function claimMiraBrowserCommand(client: SQL, input: BrowserCommandClaim) {
    return client.begin(async (query) => {
        const { context, accessId, claim } = await hostContext(client, query, input);
        await reconcile(query, context.owner);
        const [row] = await query<
            { id: string; method: BrowserCommand["method"]; payload: unknown }[]
        >`SELECT id,method,payload FROM mira_browser_commands WHERE access_id=${accessId} AND state='queued' AND expires_at>clock_timestamp() FOR UPDATE`;
        if (!row) return null;
        await receipt(query, context, row.id);
        const access = await accessForCommand(query, context, {
            accessId,
            method: row.method,
        });
        const binding = { accessId, processId: claim.id, processToken: claim.leaseToken };
        if (
            !access ||
            access.state !== "active" ||
            !(await processCurrent(query, binding))
        )
            throw failure();
        const operation = v.parse(browserCommandSchema, row.payload);
        if (operation.method !== row.method) throw failure();
        const [claimed] = await query<
            { validForMs: number }[]
        >`UPDATE mira_browser_commands SET state='claimed',payload=NULL,process_id=${claim.id},process_token=${claim.leaseToken},claimed_at=clock_timestamp(),expires_at=least(expires_at,clock_timestamp()+interval '25 seconds')
            WHERE id=${row.id} AND state='queued' AND expires_at>clock_timestamp() RETURNING greatest(0,floor(extract(epoch FROM (expires_at-clock_timestamp()))*1000))::int AS "validForMs"`;
        if (!claimed || claimed.validForMs < 1) {
            await retireBrowserCommands(query, context.owner, accessId);
            return null;
        }
        return {
            id: row.id,
            operation,
            validForMs: Math.min(25_000, claimed.validForMs),
        };
    });
}

/**
 * Commit one bounded result only for its still-current process, run and tool receipt.
 * @param client - Trusted host database.
 * @param claim - Original private controller claim.
 * @param id - Claimed command identity.
 * @param result - Worker result; images and origins are validated before persistence.
 * @returns Whether the first completion committed; no result replay is allowed.
 */
export async function finishMiraBrowserCommand(
    client: SQL,
    claim: BrowserCommandClaim,
    id: string,
    result: unknown
): Promise<boolean> {
    v.parse(uuid, id);
    return client.begin(async (query) => {
        const { context, accessId } = await hostContext(client, query, claim);
        await receipt(query, context, id);
        const [row] = await query<
            CommandRow[]
        >`SELECT id,access_id AS "accessId",method,state,process_id AS "processId",process_token AS "processToken",expires_at>clock_timestamp() AS current FROM mira_browser_commands
            WHERE id=${id} AND access_id=${accessId} AND process_id=${claim.id} AND process_token=${claim.leaseToken} AND state='claimed' FOR UPDATE`;
        if (!row) return false;
        const access = await accessForCommand(query, context, row);
        if (
            !row.current ||
            !access?.policy ||
            access.state !== "active" ||
            !(await processCurrent(query, row))
        ) {
            await retireBrowserCommands(query, context.owner, accessId);
            return false;
        }
        const parsed = browserCommandResult(row.method, result, access.policy.origins);
        const updated = await query<
            { id: string }[]
        >`UPDATE mira_browser_commands SET state='completed',result=${JSON.stringify(parsed)}::text::jsonb,finished_at=clock_timestamp() WHERE id=${id} AND state='claimed' AND expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM mira_browser_access g JOIN mira_runs r ON r.id=g.run_id JOIN mira_browser_processes p ON p.access_id=g.id
                WHERE g.id=mira_browser_commands.access_id AND g.state='active' AND g.expires_at>clock_timestamp()
                AND r.state='running' AND NOT r.cancel_requested AND r.lease_token=g.run_lease AND r.lease_expires_at>clock_timestamp()
                AND r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp()
                AND p.id=mira_browser_commands.process_id AND p.lease_token=mira_browser_commands.process_token AND p.state='active' AND p.lease_expires_at>clock_timestamp()) RETURNING id`;
        if (updated.length === 0)
            await retireBrowserCommands(query, context.owner, accessId);
        return updated.length === 1;
    });
}

/**
 * Consume result content once for the exact executor lease that admitted the command.
 * @param context - Original trusted run context.
 * @param id - Server-created receipt identity.
 * @returns Pending/terminal status or one validated result; lost consumption is never replayed.
 */
export async function takeMiraBrowserCommand(
    context: MiraContext,
    id: string
): Promise<{ state: State; result?: ReturnType<typeof browserCommandResult> }> {
    v.parse(uuid, id);
    return context.client.begin(async (query) => {
        await lockBrowserOwner(query, context.owner);
        await liveRun(query, context);
        await receipt(query, context, id);
        await reconcile(query, context.owner);
        const [row] = await query<
            CommandRow[]
        >`SELECT id,access_id AS "accessId",method,state,result,process_id AS "processId",process_token AS "processToken",expires_at>clock_timestamp() AS current
            FROM mira_browser_commands WHERE id=${id} AND owner=${context.owner} AND run_id=${context.run!.id} AND run_lease=${context.run!.leaseToken} FOR UPDATE`;
        if (!row) throw new MiraFailure("NOT_FOUND", "Browser command not found.");
        if (row.state !== "completed") return { state: row.state };
        const access = await accessForCommand(query, context, row);
        if (
            !row.current ||
            !access?.policy ||
            access.state !== "active" ||
            !(await processCurrent(query, row))
        ) {
            await retireBrowserCommands(query, context.owner, row.accessId);
            return { state: "unknown" };
        }
        const result = browserCommandResult(
            row.method,
            row.result,
            access.policy.origins
        );
        const updated = await query<
            { id: string }[]
        >`UPDATE mira_browser_commands SET state='consumed',result=NULL,finished_at=clock_timestamp() WHERE id=${id} AND state='completed' AND expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM mira_browser_access g JOIN mira_runs r ON r.id=g.run_id JOIN mira_browser_processes p ON p.access_id=g.id
                WHERE g.id=mira_browser_commands.access_id AND g.state='active' AND g.expires_at>clock_timestamp()
                AND r.state='running' AND NOT r.cancel_requested AND r.lease_token=g.run_lease AND r.lease_expires_at>clock_timestamp()
                AND r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp()
                AND p.id=mira_browser_commands.process_id AND p.lease_token=mira_browser_commands.process_token AND p.state='active' AND p.lease_expires_at>clock_timestamp()) RETURNING id`;
        if (updated.length === 0) {
            await retireBrowserCommands(query, context.owner, row.accessId);
            return { state: "unknown" };
        }
        return { state: "completed", result };
    });
}

/**
 * Stop the affected browser after uncertain delivery, cancellation or failed finalization.
 * @param context - Original owner/run/lease, even after expiry.
 * @param id - Immutable server-reserved receipt.
 * @returns Completion after transient content is scrubbed and authority revoked.
 */
export async function abandonMiraBrowserCommand(
    context: MiraContext,
    id: string
): Promise<void> {
    v.parse(uuid, id);
    if (!context.run) throw failure();
    await context.client.begin(async (query) => {
        await lockBrowserOwner(query, context.owner);
        const [row] = await query<
            { accessId: string }[]
        >`SELECT access_id AS "accessId" FROM mira_browser_commands WHERE id=${id} AND owner=${context.owner} AND run_id=${context.run!.id} AND run_lease=${context.run!.leaseToken}`;
        if (row) await retireBrowserCommands(query, context.owner, row.accessId);
    });
}

/**
 * Fence model disclosure against stop, control changes and executor/process retirement.
 * @param context - Exact executor context.
 * @param id - Consumed command and running receipt identity.
 * @param signal - Run cancellation checked before committing success.
 * @returns Completion only while the consumed result is still authorized.
 */
export async function finalizeMiraBrowserCommand(
    context: MiraContext,
    id: string,
    signal: AbortSignal
): Promise<void> {
    v.parse(uuid, id);
    await context.client.begin(async (query) => {
        await lockBrowserOwner(query, context.owner);
        await liveRun(query, context);
        await receipt(query, context, id);
        await liveRun(query, context);
        const [row] = await query<
            CommandRow[]
        >`SELECT access_id AS "accessId",method,process_id AS "processId",process_token AS "processToken" FROM mira_browser_commands
            WHERE id=${id} AND owner=${context.owner} AND run_id=${context.run!.id} AND run_lease=${context.run!.leaseToken} AND state='consumed' AND expires_at>clock_timestamp()`;
        const access = row ? await accessForCommand(query, context, row) : undefined;
        if (
            !row ||
            !access ||
            access.state !== "active" ||
            !(await processCurrent(query, row))
        )
            throw failure();
        signal.throwIfAborted();
        const updated = await query<
            { id: string }[]
        >`UPDATE mira_tool_receipts SET state='succeeded',finished_at=clock_timestamp() WHERE id=${id} AND run_id=${context.run!.id} AND state='running' AND EXISTS(SELECT 1 FROM mira_browser_commands WHERE id=${id} AND state='consumed' AND expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM mira_browser_access g JOIN mira_runs r ON r.id=g.run_id JOIN mira_browser_processes p ON p.access_id=g.id
                WHERE g.id=mira_browser_commands.access_id AND g.state='active' AND g.expires_at>clock_timestamp()
                AND r.state='running' AND NOT r.cancel_requested AND r.lease_token=g.run_lease AND r.lease_expires_at>clock_timestamp()
                AND r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp()
                AND p.id=mira_browser_commands.process_id AND p.lease_token=mira_browser_commands.process_token AND p.state='active' AND p.lease_expires_at>clock_timestamp())) RETURNING id`;
        if (updated.length !== 1) throw failure();
        signal.throwIfAborted();
    });
}
