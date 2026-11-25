import { miraDependenciesAllowed, miraRunAllowed } from "./automations";
import type { MiraQuery } from "./context";
import type { MiraClaim } from "./queue";

/** Identify morning and evening reports from their persisted invocation, including Run now.
 * @param run - Executor claim built from the immutable run snapshot.
 * @returns Whether this invocation has the read-only reporting policy.
 */
export function isMiraReportRun(run: MiraClaim): boolean {
    return (
        !!run.automationId &&
        !run.calendarEventId &&
        !run.taskAssessment &&
        (run.automationKind === "brief" || run.automationKind === "summary")
    );
}

/** Recheck a report's live lease, conversation and operator controls before returning data.
 * @param query - Product connection or the current tool transaction.
 * @param run - Claim for the owner whose configured read sources may be used.
 * @returns Whether this report still has authority.
 */
export async function miraReportRunAllowed(
    query: MiraQuery,
    run: MiraClaim
): Promise<boolean> {
    if (!isMiraReportRun(run)) return false;
    const [row] = await query<{ id: string }[]>`
        SELECT r.id FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
        WHERE r.id=${run.id} AND r.owner=${run.owner} AND r.conversation_id=${run.conversationId}
          AND r.automation_id=${run.automationId} AND r.automation_kind=${run.automationKind ?? null}
          AND r.manual=${run.manual} AND r.state='running' AND NOT r.cancel_requested
          AND r.lease_token=${run.leaseToken} AND r.lease_expires_at>clock_timestamp()
          AND c.archived_at IS NULL AND c.deleted_at IS NULL`;
    return (
        !!row &&
        (run.manual ? miraDependenciesAllowed : miraRunAllowed)(
            query,
            run.owner,
            run.automationId
        )
    );
}
