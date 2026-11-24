import type {
    MiraTask,
    MiraTaskBoardCursor,
    miraTaskBoardFilterSchema,
    miraTaskFilterSchema,
    MiraTaskInput,
} from "@homelab/contracts/mira";
import type * as v from "valibot";

import {
    auditMira,
    lockMiraProposals,
    type MiraContext,
    MiraFailure,
    miraTransaction,
    requireTask,
} from "./context";

function taskFields(sql: MiraContext["client"]) {
    return sql`id, task_number AS number, title, description, status, assignee, priority, labels, auto_start AS "autoStart",
        due_at::text AS "dueAt", completion_criteria AS "completionCriteria", completed_at::text AS "completedAt",
        conversation_id AS "conversationId", version, created_at::text AS "createdAt", updated_at::text AS "updatedAt"`;
}

function matchingTasks(
    context: MiraContext,
    input: Omit<v.InferOutput<typeof miraTaskFilterSchema>, "before">
) {
    const sql = context.client;
    const search = /^#\d+$/.test(input.search)
        ? sql`task_number = ${input.search.slice(1)}::numeric`
        : sql`strpos(lower(title || ' ' || description || ' ' || labels::text), lower(${input.search})) > 0`;
    return sql`owner = ${context.owner} AND deleted_at IS NULL AND ${search}
        AND (NOT ${input.due ?? false} OR (status <> 'done' AND due_at <= now()))
        AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
        AND (${input.assignee ?? null}::text IS NULL OR assignee = ${input.assignee ?? null})`;
}

/**
 * Read one exact owned task without scanning or depending on board pagination.
 * @param context - Authenticated operator or run-scoped actor.
 * @param id - Validated task identity, including a due-event reference.
 * @returns The live task's bounded saved fields, or a not-found error.
 */
export async function readTask(context: MiraContext, id: string): Promise<MiraTask> {
    const [task] = await context.client<MiraTask[]>`
        SELECT ${taskFields(context.client)}
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
        SELECT ${taskFields(context.client)}
        FROM mira_tasks WHERE ${matchingTasks(context, input)}
            AND (${input.before ?? null}::uuid IS NULL OR id < ${input.before ?? null}::uuid)
        ORDER BY id DESC LIMIT 30`;
    return { rows, nextCursor: rows.length === 30 ? rows.at(-1)!.id : null };
}

/**
 * Page a board column by priority or completion time, including the original sort keys
 * in its cursor so deleting or moving the boundary card does not invalidate the next page.
 * @param context - Authenticated operator.
 * @param input - Column filters and the last card's sort keys or a legacy UUID cursor.
 * @returns The next bounded page in display order.
 */
export async function listBoardTasks(
    context: MiraContext,
    input: v.InferOutput<typeof miraTaskBoardFilterSchema>
) {
    const { before, ...filters } = input;
    if (typeof before === "string") return listTasks(context, { ...filters, before });
    if (!input.status) {
        if (before)
            throw new MiraFailure(
                "BAD_REQUEST",
                "A board cursor requires a task status."
            );
        return listTasks(context, filters);
    }
    const sql = context.client;
    const done = input.status === "done";
    const rank = done
        ? sql`0`
        : sql`array_position(ARRAY['low','normal','high','urgent'], priority) - 1`;
    const date = done ? sql`completed_at` : sql`created_at`;
    const rows = await sql<(MiraTask & MiraTaskBoardCursor)[]>`
        SELECT ${taskFields(sql)}, ${rank} AS rank,
            to_char(${date} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
        FROM mira_tasks WHERE ${matchingTasks(context, filters)}
            AND (${before?.id ?? null}::uuid IS NULL OR (${rank}, ${date}, id) <
                (${before?.rank ?? null}::integer, ${before?.at ?? null}::timestamptz, ${before?.id ?? null}::uuid))
        ORDER BY rank DESC, ${date} DESC, id DESC LIMIT 31`;
    const page = rows.slice(0, 30);
    const last = page.at(-1);
    return {
        rows: page.map(({ rank: _rank, at: _at, ...task }) => task),
        nextCursor:
            rows.length > page.length && last
                ? { rank: last.rank, at: last.at, id: last.id }
                : null,
    };
}

/**
 * Create or update a task under optimistic concurrency and an attributed audit.
 * @param context - Authenticated product context.
 * @param input - Validated task fields and optional expected version.
 * @param preparationKey - Stable key for the selected repository and dependency versions.
 * @returns The affected task ID.
 */
export async function saveTask(
    context: MiraContext,
    input: MiraTaskInput & { id?: string; version?: number },
    preparationKey?: string
) {
    return miraTransaction(context, async (query) => {
        let id = input.id ?? preparationKey ?? Bun.randomUUIDv7();
        const lockKey = `mira:task:${context.owner}:${id}`;
        if (preparationKey) {
            // Prepare is an operator entry point. Serialize repeated clicks on the selection.
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey},0))`;
            const [existing] = await query<
                { id: string; deleted: boolean }[]
            >`SELECT id, deleted_at IS NOT NULL AS deleted FROM mira_tasks
              WHERE owner=${context.owner} AND (id=${preparationKey} OR (preparation_key=${preparationKey} AND deleted_at IS NULL))
              ORDER BY deleted_at NULLS FIRST LIMIT 1 FOR SHARE`;
            if (existing && !existing.deleted) return { id: existing.id };
            // Original tasks used the selection key as their ID. Keep that tombstone and its run history.
            if (existing) id = Bun.randomUUIDv7();
        } else {
            // Proposal approval may already hold the conversation row: never wait in the opposite order.
            const [lock] = await query<
                { acquired: boolean }[]
            >`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey},0)) AS acquired`;
            if (!lock?.acquired)
                throw new MiraFailure(
                    "CONFLICT",
                    "Task admission is busy. Retry after the current task action finishes."
                );
        }
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
        const [previous] = input.id
            ? await query<
                  {
                      status: string;
                      assignee: string;
                      autoStart: boolean;
                      workChanged: boolean;
                  }[]
              >`
            SELECT status, assignee, auto_start AS "autoStart", NOT (
                title=${input.title} AND description=${input.description} AND status=${input.status}
                AND assignee=${input.assignee} AND priority=${input.priority} AND labels=${JSON.stringify(input.labels)}::text::jsonb
                AND due_at IS NOT DISTINCT FROM ${due}::timestamptz
                AND completion_criteria=${input.completionCriteria} AND conversation_id IS NOT DISTINCT FROM ${input.conversationId}::uuid
            ) AS "workChanged" FROM mira_tasks WHERE id=${id} AND owner=${context.owner} AND deleted_at IS NULL FOR UPDATE`
            : [];
        const humanEdit = !context.run && context.actor === `human:${context.owner}`;
        if (!humanEdit && input.autoStart !== undefined)
            throw new MiraFailure(
                "FORBIDDEN",
                "Only the operator can change automatic task start."
            );
        const autoStart = input.autoStart ?? previous?.autoStart ?? false;
        const revokeQueuedStart = humanEdit && previous?.autoStart === true && !autoStart;
        if (revokeQueuedStart) {
            // Claims lock runs before reading tasks. Never wait in the reverse order.
            const [claim] = await query<{ acquired: boolean }[]>`
                SELECT pg_try_advisory_xact_lock(hashtextextended('homelab:mira:claim',0)) AS acquired`;
            if (!claim?.acquired)
                throw new MiraFailure(
                    "CONFLICT",
                    "Task admission is busy. Retry after the current task action finishes."
                );
        }
        const ready =
            input.assignee === "mira" && !["blocked", "done"].includes(input.status);
        let requestStart =
            humanEdit &&
            autoStart &&
            ready &&
            (!previous?.autoStart ||
                previous.assignee !== "mira" ||
                ["blocked", "done"].includes(previous.status));
        if (
            requestStart &&
            previous &&
            previous.assignee === "mira" &&
            !["blocked", "done"].includes(previous.status)
        ) {
            const [active] = await query<
                { id: string }[]
            >`SELECT id FROM mira_runs WHERE owner=${context.owner} AND task_id=${id} AND manual AND state IN ('queued','running') AND NOT cancel_requested AND (state='running' OR NOT task_auto_started OR ${previous.autoStart}) LIMIT 1`;
            if (active) requestStart = false;
        }
        const stopWork =
            humanEdit &&
            (input.status === "blocked" ||
                input.status === "done" ||
                input.assignee !== "mira");
        if (input.id) {
            const rows = await query<
                { id: string }[]
            >`UPDATE mira_tasks SET auto_start=${autoStart}, auto_start_revoked_at=CASE WHEN ${humanEdit && previous?.autoStart === true && !autoStart} THEN clock_timestamp() ELSE auto_start_revoked_at END, work_stopped_at=CASE WHEN ${stopWork} THEN clock_timestamp() ELSE work_stopped_at END, title = ${input.title}, description = ${input.description}, status = ${input.status}, assignee = ${input.assignee}, priority = ${input.priority}, labels = ${JSON.stringify(input.labels)}::text::jsonb, due_at = ${due}, completion_criteria = ${input.completionCriteria}, conversation_id = ${input.conversationId}, version = version + 1, updated_at = now() WHERE id = ${id} AND owner = ${context.owner} AND version = ${input.version ?? 0} AND deleted_at IS NULL RETURNING id`;
            if (!rows[0])
                throw new MiraFailure(
                    "CONFLICT",
                    "The task changed. Refresh before saving."
                );
        } else {
            await query`INSERT INTO mira_tasks (id, owner, preparation_key, title, description, status, assignee, priority, labels, due_at, completion_criteria, conversation_id, auto_start) VALUES (${id}, ${context.owner}, ${preparationKey ?? null}, ${input.title}, ${input.description}, ${input.status}, ${input.assignee}, ${input.priority}, ${JSON.stringify(input.labels)}::text::jsonb, ${due}, ${input.completionCriteria}, ${input.conversationId}, ${autoStart})`;
        }
        if (input.conversationId)
            await query`UPDATE mira_runs SET task_id=${id} WHERE owner=${context.owner} AND conversation_id=${input.conversationId} AND task_id IS NULL`;
        if (revokeQueuedStart) {
            const revoked = await query<{ id: string; assistantMessageId: string }[]>`
                UPDATE mira_runs SET state='interrupted',cancel_requested=true,
                    message='Automatic task start was disabled before execution.',finished_at=now()
                WHERE owner=${context.owner} AND task_id=${id} AND task_auto_started AND state='queued'
                RETURNING id,assistant_message_id AS "assistantMessageId"`;
            for (const run of revoked) {
                await query`UPDATE mira_messages SET state='interrupted' WHERE id=${run.assistantMessageId}`;
                await auditMira(query, context, "run.cancel_requested", run.id);
            }
        }
        let action = "task.created";
        if (input.id) {
            action = "task.saved";
            if (previous?.autoStart !== autoStart) action = "task.start_mode_changed";
            if (previous?.workChanged) action = "task.updated";
        }
        await auditMira(query, context, action, id);
        if (requestStart)
            await auditMira(query, context, "task.auto_start_requested", id);
        if (
            !requestStart &&
            humanEdit &&
            previous?.status === "blocked" &&
            input.status === "in_progress" &&
            input.assignee === "mira"
        )
            await auditMira(query, context, "task.resume_requested", id);
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
        // Serialize progress and its audit with assessment validation on the same task row.
        const [task] = await query<{ id: string }[]>`
            SELECT id FROM mira_tasks WHERE id=${taskId} AND owner=${context.owner}
                AND deleted_at IS NULL FOR UPDATE`;
        if (!task) throw new MiraFailure("NOT_FOUND", "Task not found.");
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
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        await lockMiraProposals(query, context.owner);
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
        const cloud = await query<
            { id: string }[]
        >`SELECT id FROM mira_daytona_jobs WHERE task_id=${id} AND owner=${context.owner} AND (state='queued' OR cleanup='pending') LIMIT 1`;
        if (cloud[0])
            throw new MiraFailure(
                "CONFLICT",
                "Cancel or finish the cloud jobs before deleting this task."
            );
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
        await query`UPDATE mira_tool_receipts t SET proposal=NULL,
            state=CASE WHEN t.state='awaiting_approval' THEN 'rejected' ELSE t.state END,
            message='The referenced task was deleted.',finished_at=now()
            FROM mira_runs r WHERE r.id=t.run_id AND r.owner=${context.owner}
            AND t.proposal IS NOT NULL
            AND ((t.tool='mira_task_update' AND t.proposal->>'id'=${id})
                OR (t.tool='mira_task_progress' AND t.proposal->>'taskId'=${id}))`;
        await query`UPDATE mira_daytona_jobs SET content='{"title":"Deleted job","command":"true","inputs":[],"outputs":[]}'::jsonb,content_hash='',stdout='',stderr='',output='',files='[]'::jsonb,message=NULL,state=CASE WHEN state='draft' THEN 'cancelled' ELSE state END,version=version+1 WHERE owner=${context.owner} AND task_id=${id}`;
        await query`DELETE FROM mira_progress WHERE task_id = ${id}`;
        await auditMira(query, context, "task.deleted", id);
    });
}
