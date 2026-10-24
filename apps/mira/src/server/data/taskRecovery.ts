import type { MiraQuery } from "./context";

/**
 * Find the latest task outcome that still requires explicit operator review.
 * @param query - Owned read handle or transaction holding the task admission lock.
 * @param owner - Authenticated task owner.
 * @param taskId - Task whose uncertain effects must not be repeated automatically.
 * @returns The unreviewed run identity, or null when task work can continue.
 */
export async function unreviewedTaskRun(query: MiraQuery, owner: string, taskId: string) {
    const [uncertain] = await query<
        { id: string }[]
    >`SELECT r.id FROM mira_runs r WHERE r.task_id = ${taskId} AND r.owner = ${owner} AND NOT EXISTS (SELECT 1 FROM mira_runs reviewed WHERE reviewed.reviewed_run_id=r.id AND reviewed.owner=r.owner AND reviewed.task_id=r.task_id) AND (r.state = 'needs_attention' OR EXISTS (SELECT 1 FROM mira_tool_receipts t WHERE t.run_id = r.id AND t.state = 'unknown')) ORDER BY r.id DESC LIMIT 1`;
    return uncertain?.id ?? null;
}
