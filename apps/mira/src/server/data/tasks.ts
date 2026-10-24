import type {
    MiraTask,
    MiraTaskInput,
    miraTaskFilterSchema,
} from "@homelab/contracts/mira";
import type * as v from "valibot";

import {
    miraTransaction,
    auditMira,
    MiraFailure,
    requireTask,
    type MiraContext,
} from "./context";

/**
 * Read one exact owned task without scanning or depending on board pagination.
 * @param context - Authenticated operator or run-scoped actor.
 * @param id - Validated task identity, including a due-event reference.
 * @returns The live task's bounded saved fields, or a not-found error.
 */
export async function readTask(context: MiraContext, id: string): Promise<MiraTask> {
    const [task] = await context.client<MiraTask[]>`
        SELECT id, title, description, status, assignee, priority, labels,
            due_at::text AS "dueAt", completion_criteria AS "completionCriteria",
            conversation_id AS "conversationId", version, created_at::text AS "createdAt", updated_at::text AS "updatedAt"
        FROM mira_tasks WHERE id = ${id} AND owner = ${context.owner} AND deleted_at IS NULL`;
    if (!task) throw new MiraFailure("NOT_FOUND", "Task not found.");
    return task;
}

/**
 * Read one bounded task-board page, applying account and filter predicates first.
 * @param context - Authenticated product context.
 * @param input - Validated search, state, assignee and cursor.
 * @returns Tasks and a continuation cursor.
 */
export async function listTasks(
    context: MiraContext,
    input: v.InferOutput<typeof miraTaskFilterSchema>
) {
    const rows = await context.client<MiraTask[]>`
        SELECT id, title, description, status, assignee, priority, labels,
            due_at::text AS "dueAt", completion_criteria AS "completionCriteria",
            conversation_id AS "conversationId", version, created_at::text AS "createdAt", updated_at::text AS "updatedAt"
        FROM mira_tasks WHERE owner = ${context.owner} AND deleted_at IS NULL
            AND (${input.before ?? null}::uuid IS NULL OR id < ${input.before ?? null}::uuid)
            AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
            AND (${input.assignee ?? null}::text IS NULL OR assignee = ${input.assignee ?? null})
            AND (strpos(lower(title || ' ' || description || ' ' || labels::text), lower(${input.search})) > 0)
        ORDER BY id DESC LIMIT 30`;
    return { rows, nextCursor: rows.length === 30 ? rows.at(-1)!.id : null };
}

/**
 * Create or update a task under optimistic concurrency and an attributed audit.
 * @param context - Authenticated product context.
 * @param input - Validated task fields and optional expected version.
 * @returns The affected task ID.
 */
export async function saveTask(
    context: MiraContext,
    input: MiraTaskInput & { id?: string; version?: number }
) {
    return miraTransaction(context, async (query) => {
        const id = input.id ?? Bun.randomUUIDv7();
        // Proposal approval may already hold the conversation row: never wait in the opposite order.
        const [lock] = await query<
            { acquired: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`mira:task:${context.owner}:${id}`},0)) AS acquired`;
        if (!lock?.acquired)
            throw new MiraFailure(
                "CONFLICT",
                "Task admission is busy. Retry after the current task action finishes."
            );
        if (input.conversationId) {
            // Serialize linking with chat admission before changing the task or adopting runs.
            const [conversation] = await query<
                { id: string }[]
            >`SELECT id FROM mira_conversations WHERE id=${input.conversationId} AND owner=${context.owner} AND deleted_at IS NULL FOR UPDATE`;
            if (!conversation)
                throw new MiraFailure("NOT_FOUND", "Conversation not found.");
            const [conflict] = await query<
                { id: string }[]
            >`SELECT t.id FROM mira_tasks t WHERE t.owner=${context.owner} AND t.id<>${id} AND ((t.deleted_at IS NULL AND t.conversation_id=${input.conversationId}) OR EXISTS (SELECT 1 FROM mira_runs r WHERE r.owner=${context.owner} AND r.conversation_id=${input.conversationId} AND r.task_id=t.id)) LIMIT 1`;
            if (conflict)
                throw new MiraFailure(
                    "CONFLICT",
                    "This conversation already belongs to another task. Choose a separate conversation."
                );
        }
        if (input.conversationId) {
            const active = await query<
                { id: string }[]
            >`SELECT id FROM mira_runs WHERE owner=${context.owner} AND state IN ('queued','running') AND (task_id=${id} OR (conversation_id=${input.conversationId} AND task_id IS NULL)) LIMIT 2`;
            if (active.length > 1)
                throw new MiraFailure(
                    "CONFLICT",
                    "Stop or finish active work before linking these conversations to the same task."
                );
        }
        const due = input.dueAt ? new Date(input.dueAt) : null;
        if (input.id) {
            const rows = await query<
                { id: string }[]
            >`UPDATE mira_tasks SET title = ${input.title}, description = ${input.description}, status = ${input.status}, assignee = ${input.assignee}, priority = ${input.priority}, labels = ${JSON.stringify(input.labels)}::text::jsonb, due_at = ${due}, completion_criteria = ${input.completionCriteria}, conversation_id = ${input.conversationId}, version = version + 1, updated_at = now() WHERE id = ${id} AND owner = ${context.owner} AND version = ${input.version ?? 0} AND deleted_at IS NULL RETURNING id`;
            if (!rows[0])
                throw new MiraFailure(
                    "CONFLICT",
                    "The task changed. Refresh before saving."
                );
        } else {
            await query`INSERT INTO mira_tasks (id, owner, title, description, status, assignee, priority, labels, due_at, completion_criteria, conversation_id) VALUES (${id}, ${context.owner}, ${input.title}, ${input.description}, ${input.status}, ${input.assignee}, ${input.priority}, ${JSON.stringify(input.labels)}::text::jsonb, ${due}, ${input.completionCriteria}, ${input.conversationId})`;
        }
        if (input.conversationId)
            await query`UPDATE mira_runs SET task_id=${id} WHERE owner=${context.owner} AND conversation_id=${input.conversationId} AND task_id IS NULL`;
        await auditMira(query, context, input.id ? "task.updated" : "task.created", id);
        return { id };
    });
}

/**
 * Read a task's attributed progress without coupling it to execution status.
 * @param context - Authenticated product context.
 * @param id - The task to inspect.
 * @param before - Optional UUID cursor.
 * @returns A bounded progress page.
 */
export async function taskProgress(context: MiraContext, id: string, before?: string) {
    await requireTask(context.client, context.owner, id);
    const rows = await context.client<
        { id: string; actor: string; content: string; createdAt: string }[]
    >`SELECT id, actor, content, created_at::text AS "createdAt" FROM mira_progress WHERE task_id = ${id} AND (${before ?? null}::uuid IS NULL OR id < ${before ?? null}::uuid) ORDER BY id DESC LIMIT 30`;
    return { rows, nextCursor: rows.length === 30 ? rows.at(-1)!.id : null };
}

/**
 * Append progress with an immutable author and audit trail.
 * @param context - Verified human or run-scoped Mira actor.
 * @param taskId - The owned task.
 * @param content - Validated progress text.
 * @returns The progress entry ID.
 */
export async function addTaskProgress(
    context: MiraContext,
    taskId: string,
    content: string
) {
    return miraTransaction(context, async (query) => {
        await requireTask(query, context.owner, taskId);
        const id = Bun.randomUUIDv7();
        await query`INSERT INTO mira_progress (id, task_id, actor, content) VALUES (${id}, ${taskId}, ${context.actor}, ${content})`;
        await auditMira(query, context, "task.progress_added", taskId);
        return { id };
    });
}

/**
 * Remove task content while retaining links and audit needed by historical runs.
 * @param context - Authenticated product context.
 * @param id - Owned task ID.
 * @param version - Version last seen by the operator.
 * @returns Completion after the task and progress content are removed.
 */
export async function deleteTask(
    context: MiraContext,
    id: string,
    version: number
): Promise<void> {
    await miraTransaction(context, async (query) => {
        const [task] = await query<
            { id: string }[]
        >`SELECT id FROM mira_tasks WHERE id = ${id} AND owner = ${context.owner} AND version = ${version} AND deleted_at IS NULL FOR UPDATE`;
        if (!task)
            throw new MiraFailure(
                "CONFLICT",
                "The task changed. Refresh before deleting."
            );
        const active = await query<
            { id: string }[]
        >`SELECT id FROM mira_runs WHERE task_id = ${id} AND owner = ${context.owner} AND state IN ('queued','running') LIMIT 1`;
        if (active.length > 0)
            throw new MiraFailure(
                "CONFLICT",
                "Stop or finish task work before deleting the task."
            );
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_tasks SET deleted_at = now(), title = 'Deleted task', description = '', completion_criteria = '', labels = '[]'::jsonb, version = version + 1 WHERE id = ${id} AND owner = ${context.owner} AND version = ${version} AND deleted_at IS NULL RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "The task changed. Refresh before deleting."
            );
        await query`DELETE FROM mira_progress WHERE task_id = ${id}`;
        await auditMira(query, context, "task.deleted", id);
    });
}
