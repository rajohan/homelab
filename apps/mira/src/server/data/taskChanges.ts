import type { MiraQuery } from "./context";

/**
 * Find the latest human board edit per task after a short quiet period.
 * @param query - Scheduler transaction or its initial owner-discovery query.
 * @param now - Scheduler clock; changes older than one day are not replayed.
 * @param owners - Already locked owners, or undefined during initial discovery.
 * @returns At most twenty unobserved changes without copying task content.
 */
export async function pendingTaskChanges(
    query: MiraQuery,
    now: Date,
    owners?: readonly string[]
) {
    return query<
        { id: string; owner: string; taskId: string; action: string; observedAt: Date }[]
    >`
        WITH latest AS (
            SELECT DISTINCT ON (a.owner,a.target) a.id,a.owner,a.target AS "taskId",a.action,a.created_at AS "observedAt"
            FROM mira_audit a JOIN mira_tasks t ON t.id::text=a.target AND t.owner=a.owner
            WHERE a.actor='human:'||a.owner AND a.action IN ('task.created','task.updated','task.progress_added')
              AND t.deleted_at IS NULL AND a.created_at>${new Date(now.getTime() - 86_400_000)} AND a.created_at<=${now}
              AND (${owners === undefined} OR a.owner IN (SELECT jsonb_array_elements_text(${JSON.stringify(owners ?? [])}::text::jsonb)))
              AND EXISTS (SELECT 1 FROM mira_automations m WHERE m.owner=a.owner AND m.deleted_at IS NULL AND m.schedule->>'kind'='event' AND m.schedule->>'event'='task_changed')
            ORDER BY a.owner,a.target,a.created_at DESC NULLS LAST,a.id DESC NULLS LAST
        )
        SELECT * FROM latest a WHERE a."observedAt"<=${new Date(now.getTime() - 5000)}
          AND NOT EXISTS (SELECT 1 FROM mira_events e WHERE e.owner=a.owner AND e.kind='task_changed' AND e.source_key=a.id::text)
        ORDER BY a."observedAt",a.id LIMIT 20`;
}

/**
 * Recheck that a queued assessment still describes the newest human edit.
 * @param query - Transaction holding the task's shared row lock.
 * @param owner - Verified account whose change is being assessed.
 * @param taskId - Live task reference, never inferred from a model prompt.
 * @param eventId - Persisted change event to validate.
 * @param now - Validation clock; queued runs also expire after one day.
 * @returns False after deletion, expiry, a newer edit or a mismatched event.
 */
export async function currentTaskChange(
    query: MiraQuery,
    owner: string,
    taskId: string,
    eventId: string,
    now: Date = new Date()
): Promise<boolean> {
    const [row] = await query<{ valid: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM mira_events e JOIN mira_tasks t ON t.id=e.task_id AND t.owner=e.owner
            WHERE e.id=${eventId} AND e.owner=${owner} AND t.id=${taskId} AND t.deleted_at IS NULL AND e.kind='task_changed'
              AND e.created_at>${new Date(now.getTime() - 86_400_000)} AND e.created_at<=${now}
              AND e.source_key=(SELECT a.id::text FROM mira_audit a WHERE a.owner=e.owner AND a.target=t.id::text
                AND a.actor='human:'||a.owner AND a.action IN ('task.created','task.updated','task.progress_added')
                ORDER BY a.created_at DESC NULLS LAST,a.id DESC NULLS LAST LIMIT 1)) AS valid`;
    return row?.valid === true;
}
