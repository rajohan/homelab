import type { MiraTask, miraTaskRunInputSchema } from "@homelab/contracts/mira";
import type * as v from "valibot";

import { auditMira, MiraFailure, requireTask, type MiraContext } from "./context";
import { enqueueTurn } from "./conversations";
import { listMiraRuns } from "./queue";
import { unreviewedTaskRun } from "./taskRecovery";

/**
 * Read execution history independently of the human-managed task status.
 * @param context - Authenticated task owner.
 * @param id - Owned, undeleted task.
 * @param before - Optional history continuation cursor.
 * @returns Current task version, bounded runs and the latest uncertain outcome to review.
 */
export async function readTaskExecution(
    context: MiraContext,
    id: string,
    before?: string
) {
    await requireTask(context.client, context.owner, id);
    const [task] = await context.client<
        { version: number; conversationId: string | null }[]
    >`SELECT version, conversation_id AS "conversationId" FROM mira_tasks WHERE id = ${id} AND owner = ${context.owner} AND deleted_at IS NULL`;
    if (!task) throw new MiraFailure("NOT_FOUND", "Task not found.");
    const uncertain = await unreviewedTaskRun(context.client, context.owner, id);
    return {
        ...(await listMiraRuns(context, before, id)),
        ...task,
        reviewRunId: uncertain,
    };
}

/**
 * Start an explicitly requested task turn or continue its existing conversation.
 * @param context - Human owner; model calls cannot start additional agent runs.
 * @param input - Expected task version, stable request identity and reviewed recovery intent.
 * @returns The durable run and conversation; a lost response can safely retry the same request.
 */
export async function runMiraTask(
    context: MiraContext,
    input: v.InferOutput<typeof miraTaskRunInputSchema>
) {
    if (context.run)
        throw new MiraFailure(
            "FORBIDDEN",
            "Task execution must be started by the operator."
        );
    const fingerprint = new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:task:${context.owner}:${input.id}`}, 0))`;
        const [existing] = await query<
            {
                id: string;
                taskId: string | null;
                conversationId: string;
                requestHash: string;
            }[]
        >`SELECT id, task_id AS "taskId", conversation_id AS "conversationId", request_hash AS "requestHash" FROM mira_runs WHERE request_key = ${`${context.owner}:${input.requestId}`}`;
        if (existing) {
            if (existing.taskId !== input.id || existing.requestHash !== fingerprint)
                throw new MiraFailure(
                    "CONFLICT",
                    "This request belongs to a different task action."
                );
            return { id: existing.id, conversationId: existing.conversationId };
        }
        const [link] = await query<
            { conversationId: string | null }[]
        >`SELECT conversation_id AS "conversationId" FROM mira_tasks WHERE id = ${input.id} AND owner = ${context.owner} AND deleted_at IS NULL`;
        if (!link) throw new MiraFailure("NOT_FOUND", "Task not found.");
        if (link.conversationId) {
            const [conversation] = await query<
                { id: string }[]
            >`SELECT id FROM mira_conversations WHERE id = ${link.conversationId} AND owner = ${context.owner} AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`;
            if (!conversation)
                throw new MiraFailure(
                    "CONFLICT",
                    "Restore the task's archived conversation before continuing."
                );
        }
        const [task] = await query<
            MiraTask[]
        >`SELECT id, title, description, completion_criteria AS "completionCriteria", assignee, status, version, conversation_id AS "conversationId" FROM mira_tasks WHERE id = ${input.id} AND owner = ${context.owner} AND deleted_at IS NULL FOR UPDATE`;
        if (
            !task ||
            task.version !== input.version ||
            task.conversationId !== link.conversationId
        )
            throw new MiraFailure(
                "CONFLICT",
                "The task changed. Refresh before starting work."
            );
        if (task.status === "blocked")
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Move the task out of Blocked before starting work."
            );
        if (task.assignee !== "mira" || task.status === "done")
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Assign an unfinished task to Mira before starting work."
            );
        const active = await query<
            { id: string }[]
        >`SELECT id FROM mira_runs WHERE task_id = ${input.id} AND owner = ${context.owner} AND state IN ('queued','running') LIMIT 1`;
        if (active.length > 0)
            throw new MiraFailure(
                "CONFLICT",
                "Stop or finish the current task run before continuing."
            );
        const uncertain = await unreviewedTaskRun(query, context.owner, input.id);
        if (uncertain && input.reviewedRunId !== uncertain)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Review the uncertain run before continuing. Previous actions will not be replayed automatically."
            );
        if (
            uncertain &&
            (await unreviewedTaskRun(query, context.owner, input.id, uncertain))
        )
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Review every uncertain task run before continuing. Reviewing an outcome does not start another run."
            );
        if (!uncertain && input.reviewedRunId)
            throw new MiraFailure(
                "CONFLICT",
                "The recovery review changed. Refresh before continuing."
            );
        const conversationId = link.conversationId ?? Bun.randomUUIDv7();
        if (!link.conversationId)
            await query`INSERT INTO mira_conversations (id, owner, title) VALUES (${conversationId}, ${context.owner}, ${`Task ${task.id.slice(0, 8)}`})`;
        const text = [
            `Task reference: ${task.id}`,
            "Read this saved task with mira_task_read before working. Use its current title, description and completion criteria; do not rely on stale copies from earlier turns.",
            input.instructions ? `Additional instructions:\n${input.instructions}` : "",
            input.reviewedRunId
                ? `I reviewed the uncertain run ${input.reviewedRunId}. Reconcile its effects before continuing; do not replay its actions automatically.`
                : "",
            "Use the available tools to record verified progress and blockers on this task. Keep the task's status separate from the run outcome. Mark it complete only with evidence for its completion criteria.",
        ]
            .filter(Boolean)
            .join("\n\n");
        const run = await enqueueTurn(
            query,
            context,
            { conversationId, requestId: input.requestId, text, attachmentIds: [] },
            { taskId: task.id, manual: true, requestHash: fingerprint }
        );
        if (input.reviewedRunId)
            await query`UPDATE mira_runs SET reviewed_run_id=${input.reviewedRunId} WHERE id=${run.id}`;
        await query`UPDATE mira_tasks SET conversation_id = ${conversationId}, version = version + 1, updated_at = now() WHERE id = ${task.id}`;
        await query`INSERT INTO mira_progress (id, task_id, actor, content) VALUES (${Bun.randomUUIDv7()}, ${task.id}, ${context.actor}, ${link.conversationId ? "Requested continued work in the linked conversation." : "Requested Mira to start work in a linked conversation."})`;
        await auditMira(query, context, "task.run_requested", task.id);
        return { ...run, conversationId };
    });
}
