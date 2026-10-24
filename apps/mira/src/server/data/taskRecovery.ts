import { auditMira, MiraFailure, type MiraQuery, type MiraContext } from "./context";

/**
 * Find the latest task outcome that still requires explicit operator review.
 * @param query - Owned read handle or transaction holding the task admission lock.
 * @param owner - Authenticated task owner.
 * @param taskId - Task whose uncertain effects must not be repeated automatically.
 * @param except - Optional identity already reviewed by the current explicit start request.
 * @returns The unreviewed run identity, or null when task work can continue.
 */
export async function unreviewedTaskRun(
    query: MiraQuery,
    owner: string,
    taskId: string,
    except: string | null = null
) {
    const [uncertain] = await query<
        { id: string }[]
    >`SELECT r.id FROM mira_runs r WHERE r.task_id = ${taskId} AND r.owner = ${owner} AND (${except}::uuid IS NULL OR r.id<>${except}::uuid) AND NOT EXISTS (SELECT 1 FROM mira_task_run_reviews acknowledged WHERE acknowledged.run_id=r.id AND acknowledged.owner=r.owner AND acknowledged.task_id=r.task_id) AND NOT EXISTS (SELECT 1 FROM mira_runs reviewed WHERE reviewed.reviewed_run_id=r.id AND reviewed.owner=r.owner AND reviewed.task_id=r.task_id) AND (r.state = 'needs_attention' OR EXISTS (SELECT 1 FROM mira_tool_receipts t WHERE t.run_id = r.id AND t.state = 'unknown')) ORDER BY r.id DESC LIMIT 1`;
    return uncertain?.id ?? null;
}

/**
 * Acknowledge one inspected uncertain outcome without queuing any additional work.
 * @param context - Human task owner; model runs cannot clear the recovery gate.
 * @param input - Exact task version and terminal run shown to the operator.
 * @returns Completion; retrying an already committed acknowledgement is harmless.
 */
export async function reviewTaskRun(
    context: MiraContext,
    input: { id: string; version: number; runId: string }
): Promise<void> {
    if (context.run)
        throw new MiraFailure(
            "FORBIDDEN",
            "Task outcomes must be reviewed by the operator."
        );
    await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:task:${context.owner}:${input.id}`},0))`;
        const [task] = await query<
            { version: number }[]
        >`SELECT version FROM mira_tasks WHERE id=${input.id} AND owner=${context.owner} AND deleted_at IS NULL FOR UPDATE`;
        if (!task) throw new MiraFailure("NOT_FOUND", "Task not found.");
        const [existing] = await query<
            { id: string }[]
        >`SELECT run_id AS id FROM mira_task_run_reviews WHERE run_id=${input.runId} AND owner=${context.owner} AND task_id=${input.id}`;
        if (existing) return;
        if (task.version !== input.version)
            throw new MiraFailure(
                "CONFLICT",
                "The task changed. Refresh before reviewing."
            );
        const [run] = await query<
            { id: string }[]
        >`SELECT r.id FROM mira_runs r WHERE r.id=${input.runId} AND r.owner=${context.owner} AND r.task_id=${input.id} AND r.state NOT IN ('queued','running') AND (r.state='needs_attention' OR EXISTS (SELECT 1 FROM mira_tool_receipts t WHERE t.run_id=r.id AND t.state='unknown'))`;
        if (!run)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "This task run has no terminal uncertain outcome to review."
            );
        await query`INSERT INTO mira_task_run_reviews(run_id,task_id,owner,actor) VALUES (${input.runId},${input.id},${context.owner},${context.actor})`;
        await query`UPDATE mira_tasks SET version=version+1,updated_at=now() WHERE id=${input.id}`;
        await auditMira(query, context, "task.run_reviewed", input.runId);
    });
}
