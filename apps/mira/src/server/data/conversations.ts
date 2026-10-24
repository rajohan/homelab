import type {
    MiraConversation,
    MiraChatSettings,
    MiraMessage,
    MiraRun,
    miraMessageInputSchema,
    miraPageSchema,
} from "@homelab/contracts/mira";
import type * as v from "valibot";

import { miraQueueAvailable } from "./capacity";
import { auditMira, MiraFailure, type MiraContext, type MiraQuery } from "./context";

/**
 * Search owned conversations and message content without leaking other accounts.
 * @param context - Authenticated product context.
 * @param input - Search, archive state and cursor.
 * @returns A bounded conversation page.
 */
export async function listConversations(
    context: MiraContext,
    input: v.InferOutput<typeof miraPageSchema>
) {
    const rows = await context.client<
        MiraConversation[]
    >`SELECT c.id, c.title, c.version, c.archived_at::text AS "archivedAt", c.created_at::text AS "createdAt", c.updated_at::text AS "updatedAt" FROM mira_conversations c WHERE c.owner = ${context.owner} AND c.deleted_at IS NULL AND (c.archived_at IS NOT NULL) = ${input.archived} AND (${input.before ?? null}::uuid IS NULL OR c.id < ${input.before ?? null}::uuid) AND (strpos(lower(c.title), lower(${input.search})) > 0 OR EXISTS (SELECT 1 FROM mira_messages m WHERE m.conversation_id = c.id AND strpos(lower(m.content), lower(${input.search})) > 0)) ORDER BY c.id DESC LIMIT 30`;
    return { rows, nextCursor: rows.length === 30 ? rows.at(-1)!.id : null };
}

/**
 * Create a product conversation independently of any provider session.
 * @param context - Authenticated product context.
 * @param title - Validated initial title.
 * @returns The product ID, which remains stable across runtime replacements.
 */
export async function createConversation(context: MiraContext, title: string) {
    return context.client.begin(async (query) => {
        const id = Bun.randomUUIDv7();
        await query`INSERT INTO mira_conversations (id, owner, title) VALUES (${id}, ${context.owner}, ${title})`;
        await auditMira(query, context, "conversation.created", id);
        return { id };
    });
}

/**
 * Read a conversation's durable streaming text and current run after reconnecting.
 * @param context - Authenticated product context.
 * @param id - Owned conversation reference.
 * @param before - Optional older-message cursor.
 * @returns Conversation metadata, ordered messages and the latest execution.
 */
export async function readConversation(
    context: MiraContext,
    id: string,
    before?: string
) {
    const [conversation] = await context.client<
        (MiraConversation & { settings: MiraChatSettings })[]
    >`SELECT id, title, version, settings, archived_at::text AS "archivedAt", created_at::text AS "createdAt", updated_at::text AS "updatedAt" FROM mira_conversations WHERE id = ${id} AND owner = ${context.owner} AND deleted_at IS NULL`;
    if (!conversation) throw new MiraFailure("NOT_FOUND", "Conversation not found.");
    const rows = await context.client<
        MiraMessage[]
    >`SELECT id, role, content, state, attachment_ids AS "attachmentIds", created_at::text AS "createdAt" FROM mira_messages WHERE conversation_id = ${id} AND (${before ?? null}::uuid IS NULL OR id < ${before ?? null}::uuid) ORDER BY id DESC LIMIT 50`;
    const [run] = await context.client<
        MiraRun[]
    >`SELECT id, conversation_id AS "conversationId", automation_id AS "automationId", task_id AS "taskId", activity, state, cancel_requested AS "cancelRequested", message, created_at::text AS "createdAt", started_at::text AS "startedAt", finished_at::text AS "finishedAt" FROM mira_runs WHERE conversation_id = ${id} ORDER BY id DESC LIMIT 1`;
    const tools = run
        ? await context.client<
              {
                  id: string;
                  tool: string;
                  state: string;
                  message: string | null;
                  createdAt: string;
                  finishedAt: string | null;
              }[]
          >`SELECT id, tool, state, message, created_at::text AS "createdAt", finished_at::text AS "finishedAt" FROM mira_tool_receipts WHERE run_id = ${run.id} ORDER BY created_at, id LIMIT 32`
        : [];
    return {
        conversation,
        tools,
        messages: rows.toReversed(),
        run: run ?? null,
        nextCursor: rows.length === 50 ? rows.at(-1)!.id : null,
    };
}

/**
 * Enqueue a durable turn once while serializing competing conversation mutations.
 * @param query - Transaction held by the caller.
 * @param context - Verified human or scheduler actor.
 * @param input - Validated user message and idempotency key.
 * @param source - Internal execution policy, never supplied by public chat input.
 * @returns The durable run ID, including on an identical request retry.
 */
export async function enqueueTurn(
    query: MiraQuery,
    context: Pick<MiraContext, "owner" | "actor">,
    input: v.InferOutput<typeof miraMessageInputSchema>,
    source: {
        automationId?: string;
        taskId?: string;
        budgetSeconds?: number;
        manual?: boolean;
    } = {}
) {
    const [conversation] = await query<
        { id: string; settings: MiraChatSettings }[]
    >`SELECT id, settings FROM mira_conversations WHERE id = ${input.conversationId} AND owner = ${context.owner} AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`;
    if (!conversation)
        throw new MiraFailure("NOT_FOUND", "Open an active conversation before sending.");
    const requestKey = `${context.owner}:${input.requestId}`;
    const hash = new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
    const [existing] = await query<
        { id: string; requestHash: string }[]
    >`SELECT id, request_hash AS "requestHash" FROM mira_runs WHERE request_key = ${requestKey}`;
    if (existing) {
        if (existing.requestHash !== hash)
            throw new MiraFailure(
                "CONFLICT",
                "This request identifier already belongs to another message."
            );
        return { id: existing.id };
    }
    const active = await query<
        { id: string }[]
    >`SELECT id FROM mira_runs WHERE conversation_id = ${input.conversationId} AND state IN ('queued','running')`;
    if (active[0])
        throw new MiraFailure(
            "CONFLICT",
            "Wait for the current reply or stop it before sending another message."
        );
    for (const id of input.attachmentIds) {
        const files = await query<
            { id: string }[]
        >`SELECT id FROM mira_attachments WHERE id = ${id} AND owner = ${context.owner} AND deleted_at IS NULL AND ready_at IS NOT NULL FOR SHARE`;
        if (!files[0])
            throw new MiraFailure("NOT_FOUND", "An attachment is no longer available.");
    }
    const manual = source.manual ?? !source.automationId;
    if (!(await miraQueueAvailable(query, context.owner, manual)))
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Mira's queue is full. Stop or finish queued work before adding more."
        );
    const id = Bun.randomUUIDv7(),
        userMessage = Bun.randomUUIDv7(),
        assistantMessage = Bun.randomUUIDv7();
    await query`INSERT INTO mira_messages (id, conversation_id, role, content, state, attachment_ids) VALUES (${userMessage}, ${input.conversationId}, 'user', ${input.text}, 'completed', ${JSON.stringify(input.attachmentIds)}::text::jsonb), (${assistantMessage}, ${input.conversationId}, 'assistant', '', 'queued', '[]'::jsonb)`;
    await query`INSERT INTO mira_runs (id, owner, request_key, request_hash, conversation_id, user_message_id, assistant_message_id, automation_id, task_id, state, priority, budget_seconds, manual, settings) VALUES (${id}, ${context.owner}, ${requestKey}, ${hash}, ${input.conversationId}, ${userMessage}, ${assistantMessage}, ${source.automationId ?? null}, ${source.taskId ?? null}, 'queued', ${manual ? 100 : 0}, ${source.budgetSeconds ?? 300}, ${manual}, ${JSON.stringify(conversation.settings)}::text::jsonb)`;
    await query`UPDATE mira_conversations SET version = version + 1, updated_at = now() WHERE id = ${input.conversationId}`;
    await auditMira(query, context, "run.queued", id);
    return { id };
}

/**
 * Request cancellation without reporting an active provider turn as already stopped.
 * @param context - Authenticated product context.
 * @param id - Owned execution ID.
 * @returns Completion after the cancellation intent is durable.
 */
export async function cancelRun(context: MiraContext, id: string): Promise<void> {
    await context.client.begin(async (query) => {
        const [run] = await query<
            { state: string; assistantMessage: string }[]
        >`SELECT state, assistant_message_id AS "assistantMessage" FROM mira_runs WHERE id = ${id} AND owner = ${context.owner} FOR UPDATE`;
        if (!run) throw new MiraFailure("NOT_FOUND", "Run not found.");
        if (!["queued", "running"].includes(run.state)) return;
        await query`UPDATE mira_runs SET cancel_requested = true, state = CASE WHEN state = 'queued' THEN 'interrupted' ELSE state END, finished_at = CASE WHEN state = 'queued' THEN now() ELSE finished_at END WHERE id = ${id}`;
        if (run.state === "queued")
            await query`UPDATE mira_messages SET state = 'interrupted' WHERE id = ${run.assistantMessage}`;
        await auditMira(query, context, "run.cancel_requested", id);
    });
}

/**
 * Rename an owned conversation using the version last shown in the browser.
 * @param context - Authenticated product context.
 * @param input - Identity, expected version and validated title.
 * @returns Completion after the rename and audit commit.
 */
export async function renameConversation(
    context: MiraContext,
    input: { id: string; version: number; title: string }
): Promise<void> {
    await context.client.begin(async (query) => {
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_conversations SET title = ${input.title}, version = version + 1, updated_at = now() WHERE id = ${input.id} AND owner = ${context.owner} AND version = ${input.version} AND deleted_at IS NULL RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "The conversation changed. Refresh before renaming."
            );
        await auditMira(query, context, "conversation.renamed", input.id);
    });
}

/**
 * Archive or remove chat content only after its active execution has stopped.
 * @param context - Authenticated product context.
 * @param input - Record, expected version and lifecycle action.
 * @returns Completion after the transition; provider cleanup is handled by the executor.
 */
export async function changeConversation(
    context: MiraContext,
    input: { id: string; version: number; action: "archive" | "restore" | "delete" }
): Promise<void> {
    await context.client.begin(async (query) => {
        const rows = await query<
            { id: string }[]
        >`SELECT id FROM mira_conversations WHERE id = ${input.id} AND owner = ${context.owner} AND version = ${input.version} AND deleted_at IS NULL FOR UPDATE`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "The conversation changed. Refresh before continuing."
            );
        const active = await query<
            { id: string }[]
        >`SELECT id FROM mira_runs WHERE conversation_id = ${input.id} AND state IN ('queued','running')`;
        if (active[0])
            throw new MiraFailure(
                "CONFLICT",
                "Stop the active run before changing the conversation."
            );
        await query`UPDATE mira_conversations SET archived_at = ${input.action === "archive" ? new Date() : null}, deleted_at = ${input.action === "delete" ? new Date() : null}, title = CASE WHEN ${input.action === "delete"} THEN 'Deleted conversation' ELSE title END, version = version + 1, updated_at = now() WHERE id = ${input.id}`;
        if (input.action === "delete") {
            await query`UPDATE mira_messages SET content = '', attachment_ids = '[]'::jsonb WHERE conversation_id = ${input.id}`;
            await query`UPDATE mira_tasks SET conversation_id = NULL, version = version + 1, updated_at = now() WHERE conversation_id = ${input.id} AND owner = ${context.owner}`;
        }
        await auditMira(query, context, `conversation.${input.action}`, input.id);
    });
}
