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
    requireConversation,
    requireTask,
    type MiraContext,
} from "./context";

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
        await requireConversation(query, context.owner, input.conversationId);
        const id = input.id ?? Bun.randomUUIDv7();
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
