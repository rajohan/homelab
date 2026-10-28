import {
    miraComputerCommandBindingSchema,
    miraComputerOperationSchema,
    type MiraComputerCommand,
} from "@homelab/contracts/miraComputerCommands";
import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import {
    computerCommandResult,
    type ComputerCommandResult,
} from "../computer/commandResult";
import {
    lockComputerOwner,
    readComputerAccess,
    requireComputerDevice,
} from "./computerAuthority";
import { MiraFailure, type MiraContext } from "./context";

const idSchema = v.pipe(v.string(), v.uuid());
const completionSchema = v.strictObject({
    ...miraComputerCommandBindingSchema.entries,
    commandId: idSchema,
    result: v.unknown(),
});
type State = "queued" | "claimed" | "completed" | "consumed" | "refused" | "unknown";
interface CommandRow {
    id: string;
    accessId: string;
    connectionId: string;
    targetId: string;
    action: "observe" | "click" | "type";
    state: State;
    result: unknown;
}

async function liveRun(query: TransactionSQL, context: MiraContext) {
    if (!context.run)
        throw new MiraFailure("FORBIDDEN", "Computer commands require an active run.");
    const [run] = await query<
        { id: string }[]
    >`SELECT id FROM mira_runs WHERE id=${context.run.id} AND owner=${context.owner}
        AND state='running' AND NOT cancel_requested AND lease_token=${context.run.leaseToken}
        AND lease_expires_at>clock_timestamp() AND started_at+budget_seconds*interval '1 second'>clock_timestamp() FOR SHARE`;
    if (!run)
        throw new MiraFailure(
            "FORBIDDEN",
            "Computer command run is no longer available."
        );
}

/**
 * Erase transient content and retire an access that has outstanding commands.
 * @param query - Transaction already holding the account control lock.
 * @param owner - Verified owner.
 * @param accessId - Exact grant to stop; only queued work is known to be undelivered.
 * @returns Number of content-bearing commands retired, preserving replay tombstones.
 */
export async function retireComputerCommands(
    query: TransactionSQL,
    owner: string,
    accessId: string
): Promise<number> {
    const rows = await query<
        { id: string }[]
    >`UPDATE mira_computer_commands SET state=CASE WHEN state='queued' THEN 'refused' ELSE 'unknown' END,
        payload=NULL,result=NULL,finished_at=clock_timestamp() WHERE owner=${owner} AND access_id=${accessId} AND state IN ('queued','claimed','completed') RETURNING id`;
    if (rows.length > 0)
        await query`UPDATE mira_computer_access SET state='stopped',stopped_at=clock_timestamp() WHERE id=${accessId} AND owner=${owner} AND state<>'stopped'`;
    return rows.length;
}

/**
 * Retire outstanding content when a device reconnects or is revoked.
 * @param query - Transaction holding the owner control lock and device row lock.
 * @param owner - Verified account.
 * @param computerId - Exact paired device; no other computer's commands are changed.
 * @returns Completion after command content and affected sessions are retired.
 */
export async function retireComputerDeviceCommands(
    query: TransactionSQL,
    owner: string,
    computerId: string
): Promise<void> {
    const rows = await query<
        { id: string }[]
    >`SELECT DISTINCT g.id FROM mira_computer_access g JOIN mira_computer_commands c ON c.access_id=g.id
        WHERE g.owner=${owner} AND g.computer_id=${computerId} AND c.state IN ('queued','claimed','completed')`;
    for (const row of rows) await retireComputerCommands(query, owner, row.id);
}

async function deviceAccess(
    query: TransactionSQL,
    device: { id: string; owner: string },
    binding: v.InferOutput<typeof miraComputerCommandBindingSchema>
) {
    const first = await readComputerAccess(query, device.owner, binding.accessId);
    if (!first || first.computerId !== device.id) return;
    // The executor can retire its run/receipt without the account lock. Hold both while disclosing content.
    await query`SELECT id FROM mira_runs WHERE id=${first.runId} FOR SHARE`;
    await query`SELECT receipt.id FROM mira_tool_receipts receipt JOIN mira_computer_commands cmd ON cmd.id=receipt.id
        WHERE cmd.access_id=${first.id} AND cmd.state IN ('queued','claimed','completed') ORDER BY receipt.id FOR SHARE OF receipt`;
    const access = await readComputerAccess(query, device.owner, binding.accessId);
    return access?.available &&
        access.state === "active" &&
        access.computerId === device.id &&
        access.connectionId === binding.connectionId &&
        access.targetId === binding.targetId
        ? access
        : undefined;
}

async function reconcile(query: TransactionSQL, owner: string): Promise<number> {
    const rows = await query<
        { accessId: string; expired: boolean }[]
    >`SELECT access_id AS "accessId",expires_at<=clock_timestamp() AS expired
        FROM mira_computer_commands WHERE owner=${owner} AND state IN ('queued','claimed','completed') ORDER BY id`;
    let retired = 0;
    for (const row of rows) {
        const access = await readComputerAccess(query, owner, row.accessId);
        if (row.expired || !access?.available || access.state !== "active")
            retired += await retireComputerCommands(query, owner, row.accessId);
    }
    return retired;
}

/**
 * Clear expired/revoked transient command content independently of provider availability.
 * @param client - Product database; global admission bounds active rows to thirty-two.
 * @returns Number of retired commands; no input, image or native details are logged.
 */
export async function cleanupMiraComputerCommands(client: SQL): Promise<number> {
    const owners = await client<
        { owner: string }[]
    >`SELECT DISTINCT owner FROM mira_computer_commands WHERE state IN ('queued','claimed','completed') ORDER BY owner LIMIT 32`;
    let count = 0;
    for (const { owner } of owners)
        count += await client.begin(async (query) => {
            await lockComputerOwner(query, owner);
            return reconcile(query, owner);
        });
    return count;
}

/**
 * Reserve one durable command for a previously reserved executor tool receipt.
 * @param context - Trusted active run/lease, never device or model-supplied identity.
 * @param receiptId - Server-reserved tool receipt, also the immutable command identity.
 * @param input - Validated observation or scoped input; the active grant supplies its target.
 * @returns Command identity after commit. Admission failure never dispatches native work.
 */
export async function enqueueMiraComputerCommand(
    context: MiraContext,
    receiptId: string,
    input: unknown
): Promise<{ id: string }> {
    v.parse(idSchema, receiptId);
    const operation = v.parse(miraComputerOperationSchema, input);
    if (
        operation.action === "type" &&
        (!operation.text.isWellFormed() || operation.text.includes("\u0000"))
    )
        throw new MiraFailure(
            "BAD_REQUEST",
            "Computer text must be valid Unicode without null characters."
        );
    const result = await context.client.begin(async (query) => {
        // Global capacity is serialized before account/row locks; cleanup never acquires this lock.
        await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:computer-command-capacity',0))`;
        await lockComputerOwner(query, context.owner);
        await liveRun(query, context);
        const [receipt] = await query<
            { id: string }[]
        >`SELECT id FROM mira_tool_receipts WHERE id=${receiptId} AND run_id=${context.run!.id}
            AND state='running' AND tool=${operation.action === "observe" ? "mira_computer_observe" : "mira_computer_input"} FOR SHARE`;
        if (!receipt)
            throw new MiraFailure(
                "FORBIDDEN",
                "Computer command requires its reserved tool receipt."
            );
        await reconcile(query, context.owner);
        const [candidate] = await query<
            { id: string }[]
        >`SELECT id FROM mira_computer_access WHERE owner=${context.owner} AND run_id=${context.run!.id} AND state='active'`;
        const access = candidate
            ? await readComputerAccess(query, context.owner, candidate.id)
            : undefined;
        if (
            !access?.available ||
            !access.targetId ||
            access.runLease !== context.run!.leaseToken ||
            (operation.action !== "observe" && access.mode !== "control")
        )
            return null;
        const [limits] = await query<
            {
                total: number;
                owned: number;
                busy: boolean;
                attempted: boolean;
                recent: number;
            }[]
        >`SELECT
            (SELECT count(*)::int FROM mira_computer_commands WHERE state IN ('queued','claimed','completed')) AS total,
            (SELECT count(*)::int FROM mira_computer_commands WHERE owner=${context.owner} AND state IN ('queued','claimed','completed')) AS owned,
            EXISTS(SELECT 1 FROM mira_computer_commands WHERE access_id=${access.id} AND state IN ('queued','claimed','completed')) AS busy,
            EXISTS(SELECT 1 FROM mira_computer_commands WHERE id=${receiptId}) AS attempted,
            (SELECT count(*)::int FROM mira_computer_commands WHERE access_id=${access.id}) AS recent`;
        if (
            !limits ||
            limits.total >= 32 ||
            limits.owned >= 8 ||
            limits.busy ||
            limits.attempted ||
            limits.recent >= 32
        )
            return null;
        await query`WITH timing AS MATERIALIZED (SELECT clock_timestamp() AS at)
            INSERT INTO mira_computer_commands(id,owner,access_id,run_id,run_lease,connection_id,target_id,action,payload,created_at,expires_at)
            SELECT ${receiptId},${context.owner},${access.id},${context.run!.id},${context.run!.leaseToken},${access.connectionId},${access.targetId},${operation.action},${JSON.stringify(operation)}::text::jsonb,timing.at,timing.at+interval '15 seconds' FROM timing`;
        return { id: receiptId };
    });
    if (!result)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Computer access is unavailable, busy or at its command limit. Refresh before continuing."
        );
    return result;
}

/**
 * Atomically deliver the next command once to its exact paired connection and target.
 * @param client - Product database reached only through the private machine listener.
 * @param token - Device credential, never an executor or browser credential.
 * @param input - Accepted access, current generation and locally selected opaque target.
 * @returns One bounded command or null; committed claims are never reclaimed or replayed.
 */
export async function claimMiraComputerCommand(
    client: SQL,
    token: string,
    input: unknown
): Promise<{ command: MiraComputerCommand | null }> {
    const binding = v.parse(miraComputerCommandBindingSchema, input);
    return client.begin(async (query) => {
        const device = await requireComputerDevice(query, token, binding.connectionId);
        await reconcile(query, device.owner);
        const access = await deviceAccess(query, device, binding);
        if (!access) return { command: null };
        const [row] = await query<
            { id: string; payload: unknown }[]
        >`SELECT id,payload FROM mira_computer_commands WHERE owner=${device.owner} AND access_id=${access.id}
            AND connection_id=${binding.connectionId} AND target_id=${binding.targetId} AND state='queued' AND expires_at>clock_timestamp() FOR UPDATE`;
        if (!row) return { command: null };
        const operation = v.parse(miraComputerOperationSchema, row.payload);
        if (operation.action !== "observe" && access.mode !== "control")
            return { command: null };
        const [claimed] = await query<
            { validForMs: number }[]
        >`UPDATE mira_computer_commands SET state='claimed',payload=NULL,claimed_at=clock_timestamp(),
            expires_at=least(expires_at,clock_timestamp()+interval '10 seconds') WHERE id=${row.id} AND state='queued' AND expires_at>clock_timestamp()
            RETURNING greatest(0,floor(extract(epoch FROM (expires_at-clock_timestamp()))*1000))::int AS "validForMs"`;
        if (!claimed || claimed.validForMs < 1) {
            await retireComputerCommands(query, device.owner, access.id);
            return { command: null };
        }
        return {
            command: {
                ...binding,
                commandId: row.id,
                validForMs: Math.min(10_000, claimed.validForMs),
                operation,
            },
        };
    });
}

/**
 * Accept a single result while its command, session and owning run remain authorized.
 * @param client - Private product database.
 * @param token - Same paired device and generation that claimed the command.
 * @param input - Exact command binding and bounded inline result; no native paths or input text echo.
 * @returns Whether this first completion was committed; stale or duplicate data is discarded.
 */
export async function finishMiraComputerCommand(
    client: SQL,
    token: string,
    input: unknown
): Promise<{ commandId: string; accepted: boolean }> {
    const request = v.parse(completionSchema, input);
    const accepted = await client.begin(async (query) => {
        const device = await requireComputerDevice(query, token, request.connectionId);
        await reconcile(query, device.owner);
        const access = await deviceAccess(query, device, request);
        if (!access) return false;
        const [row] = await query<
            CommandRow[]
        >`SELECT id,action,state FROM mira_computer_commands WHERE id=${request.commandId} AND owner=${device.owner}
            AND access_id=${access.id} AND connection_id=${request.connectionId} AND target_id=${request.targetId} AND state='claimed' FOR UPDATE`;
        if (!row) return false;
        const result = computerCommandResult(row.action, request.result);
        if ("effect" in result && result.effect === "unknown") {
            await retireComputerCommands(query, device.owner, access.id);
            return false;
        }
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_computer_commands SET state='completed',result=${JSON.stringify(result)}::text::jsonb,finished_at=clock_timestamp()
            WHERE id=${row.id} AND state='claimed' AND expires_at>clock_timestamp() RETURNING id`;
        if (rows.length === 0)
            await retireComputerCommands(query, device.owner, access.id);
        return rows.length === 1;
    });
    return { commandId: request.commandId, accepted };
}

/**
 * Consume authorized content once, or read a content-free pending/terminal state.
 * @param context - Same trusted live run and lease that reserved the command.
 * @param id - Immutable server-reserved command identity.
 * @returns State and optional one-time result. Lost consumption is never replayed.
 */
export async function takeMiraComputerCommand(
    context: MiraContext,
    id: string
): Promise<{ state: State; result?: ComputerCommandResult }> {
    v.parse(idSchema, id);
    return context.client.begin(async (query) => {
        await lockComputerOwner(query, context.owner);
        await liveRun(query, context);
        await query`SELECT id FROM mira_tool_receipts WHERE id=${id} AND run_id=${context.run!.id} FOR SHARE`;
        await reconcile(query, context.owner);
        const [row] = await query<
            CommandRow[]
        >`SELECT id,access_id AS "accessId",action,state,result FROM mira_computer_commands
            WHERE id=${id} AND owner=${context.owner} AND run_id=${context.run!.id} AND run_lease=${context.run!.leaseToken} FOR UPDATE`;
        if (!row) throw new MiraFailure("NOT_FOUND", "Computer command not found.");
        if (row.state !== "completed") return { state: row.state };
        const result = computerCommandResult(row.action, row.result);
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_computer_commands SET state='consumed',result=NULL,finished_at=clock_timestamp()
            WHERE id=${id} AND state='completed' AND expires_at>clock_timestamp() RETURNING id`;
        if (rows.length === 0) {
            await retireComputerCommands(query, context.owner, row.accessId);
            return { state: "unknown" as const };
        }
        return { state: "completed" as const, result };
    });
}

/**
 * Retire the exact command's grant after cancellation, lost result or finalization failure.
 * @param context - Original run/lease; retirement is still allowed after that lease expires.
 * @param id - Server-reserved receipt, never a model-selected access ID.
 * @returns Completion after content is erased and further native permits are denied.
 */
export async function abandonMiraComputerCommand(
    context: MiraContext,
    id: string
): Promise<void> {
    if (!context.run) throw new Error("Computer retirement requires its original run.");
    v.parse(idSchema, id);
    await context.client.begin(async (query) => {
        await lockComputerOwner(query, context.owner);
        const [row] = await query<{ accessId: string }[]>`SELECT access_id AS "accessId"
            FROM mira_computer_commands WHERE id=${id} AND owner=${context.owner}
            AND run_id=${context.run!.id} AND run_lease=${context.run!.leaseToken}`;
        if (!row) return;
        await query`UPDATE mira_computer_access SET state='stopped',stopped_at=clock_timestamp()
            WHERE id=${row.accessId} AND owner=${context.owner} AND state<>'stopped'`;
        await retireComputerCommands(query, context.owner, row.accessId);
    });
}

/**
 * Fence result disclosure against human stop, control changes and run/receipt retirement.
 * @param context - Exact original executor run and lease.
 * @param id - Consumed command and reserved tool receipt identity.
 * @param signal - Current run cancellation, checked before committing success.
 * @returns Completion only while this result's grant is still authorized.
 */
export async function finalizeMiraComputerCommand(
    context: MiraContext,
    id: string,
    signal: AbortSignal
): Promise<void> {
    v.parse(idSchema, id);
    await context.client.begin(async (query) => {
        await lockComputerOwner(query, context.owner);
        await liveRun(query, context);
        // Receipt retirement can wait independently of the account lock. Recheck time after it.
        await query`SELECT id FROM mira_tool_receipts WHERE id=${id} AND run_id=${context.run!.id} FOR UPDATE`;
        await liveRun(query, context);
        const [row] = await query<
            { accessId: string }[]
        >`SELECT access_id AS "accessId" FROM mira_computer_commands
            WHERE id=${id} AND owner=${context.owner} AND run_id=${context.run!.id}
            AND run_lease=${context.run!.leaseToken} AND state='consumed' AND expires_at>clock_timestamp()`;
        const access = row
            ? await readComputerAccess(query, context.owner, row.accessId)
            : undefined;
        if (
            !access?.available ||
            access.state !== "active" ||
            access.runLease !== context.run!.leaseToken
        )
            throw new Error("Computer result lost its authority before delivery.");
        signal.throwIfAborted();
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_tool_receipts SET state='succeeded',finished_at=clock_timestamp()
            WHERE id=${id} AND run_id=${context.run!.id} AND state='running' RETURNING id`;
        if (rows.length !== 1) throw new Error("Computer result lost its tool receipt.");
        signal.throwIfAborted();
    });
}
