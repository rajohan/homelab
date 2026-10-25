import type { SQL, TransactionSQL } from "bun";

export interface MiraContext {
    readonly client: SQL;
    readonly transaction?: TransactionSQL;
    readonly owner: string;
    readonly actor: string;
    readonly run?: { readonly id: string; readonly leaseToken: string };
}
export type MiraQuery = SQL | TransactionSQL;

/**
 * Join an enclosing tool transaction or create the ordinary product mutation transaction.
 * @param context - Owned product context with an optional receipt transaction.
 * @param operation - Mutation and audit work that must commit together.
 * @returns The operation result after its owning transaction commits.
 */
export async function miraTransaction<T>(
    context: MiraContext,
    operation: (query: TransactionSQL) => Promise<T>
): Promise<T> {
    return context.transaction
        ? operation(context.transaction)
        : context.client.begin(operation);
}

/**
 * Serialize proposal creation, decisions and content deletion for one account.
 * Acquire this before conversation, run, task or receipt locks so deletion cannot
 * race a new proposal or invert the approval lock order.
 * @param query - The transaction that will create, decide or scrub proposals.
 * @param owner - Verified account whose proposal content is changing.
 * @returns Completion once competing proposal mutations have finished.
 */
export async function lockMiraProposals(query: MiraQuery, owner: string): Promise<void> {
    await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:proposals:${owner}`}, 0))`;
}

/** A deliberately public domain error without provider, database or file details. */
export class MiraFailure extends Error {
    readonly code:
        | "BAD_REQUEST"
        | "CONFLICT"
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "PRECONDITION_FAILED";
    /**
     * Create a user-actionable failure for the authenticated transport boundary.
     * @param code - Reviewed public error category.
     * @param message - Safe explanation without private diagnostics.
     */
    constructor(code: MiraFailure["code"], message: string) {
        super(message);
        this.name = "MiraFailure";
        this.code = code;
    }
}

/**
 * Record the actor and affected object without copying private message content.
 * @param query - The same transaction as the mutation.
 * @param context - Verified owner and actor, never supplied by a model.
 * @param action - Stable operation name.
 * @param target - Product record identity.
 * @returns Completion after the audit insert.
 */
export async function auditMira(
    query: MiraQuery,
    context: Pick<MiraContext, "owner" | "actor" | "run">,
    action: string,
    target: string
): Promise<void> {
    if (context.run) {
        const rows = await query<
            { id: string }[]
        >`SELECT id FROM mira_runs WHERE id = ${context.run.id} AND owner = ${context.owner} AND lease_token = ${context.run.leaseToken} AND state = 'running' AND NOT cancel_requested AND lease_expires_at > clock_timestamp() FOR UPDATE`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "This run no longer has permission to write."
            );
    }
    await query`INSERT INTO mira_audit (id, owner, actor, action, target) VALUES (${Bun.randomUUIDv7()}, ${context.owner}, ${context.actor}, ${action}, ${target})`;
}

/**
 * Check a linked conversation belongs to the same account and is not deleted.
 * @param query - Current read or transaction handle.
 * @param owner - Verified product owner.
 * @param id - Optional conversation reference.
 * @returns Completion when the link is valid.
 */
export async function requireConversation(
    query: MiraQuery,
    owner: string,
    id: string | null
): Promise<void> {
    if (!id) return;
    const rows = await query<
        { id: string }[]
    >`SELECT id FROM mira_conversations WHERE id = ${id} AND owner = ${owner} AND deleted_at IS NULL FOR SHARE`;
    if (!rows[0]) throw new MiraFailure("NOT_FOUND", "Conversation not found.");
}

/**
 * Check a task link without exposing records belonging to another operator.
 * @param query - Current read or transaction handle.
 * @param owner - Verified product owner.
 * @param id - Optional task reference.
 * @returns Completion when the link is valid.
 */
export async function requireTask(
    query: MiraQuery,
    owner: string,
    id: string | null
): Promise<void> {
    if (!id) return;
    const rows = await query<
        { id: string }[]
    >`SELECT id FROM mira_tasks WHERE id = ${id} AND owner = ${owner} AND deleted_at IS NULL FOR SHARE`;
    if (!rows[0]) throw new MiraFailure("NOT_FOUND", "Task not found.");
}
