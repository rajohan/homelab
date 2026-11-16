import type { miraRunListSchema, MiraRunSummary } from "@homelab/contracts/mira";
import type { MiraContext } from "@homelab/mira/data/context";
import type * as v from "valibot";

import { sortedPage } from "../operations/sortedPage";

/**
 * Sort and filter all owned runs before taking a page.
 * @param context - Authenticated owner; deleted conversations retain their audit outcomes.
 * @param input - Validated sort boundary and optional unresolved-follow-up filter.
 * @returns Stable pages ordered across the complete matching history.
 */
export async function listMiraRunHistory(
    context: MiraContext,
    input: v.InferOutput<typeof miraRunListSchema>
) {
    const query = context.client;
    const page = await sortedPage<MiraRunSummary>(
        query,
        query`SELECT r.followup_resolution AS "followupResolution",r.id,r.conversation_id AS "conversationId",r.automation_id AS "automationId",r.task_id AS "taskId",r.state,r.cancel_requested AS "cancelRequested",r.message,r.created_at::text AS "createdAt",r.started_at::text AS "startedAt",r.finished_at::text AS "finishedAt",COALESCE(c.title,'Deleted conversation') AS title,a.title AS "automationName",c.id IS NOT NULL AS "conversationAvailable"
            FROM mira_runs r
            LEFT JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner AND c.deleted_at IS NULL
            LEFT JOIN mira_automations a ON a.id=r.automation_id AND a.owner=r.owner AND a.deleted_at IS NULL
            WHERE r.owner=${context.owner}
            AND (NOT ${input.needsReview} OR (r.followup_resolution IS NULL AND r.state NOT IN ('queued','running')
                AND (r.state IN ('failed','interrupted','needs_attention') OR EXISTS(SELECT 1 FROM mira_tool_receipts t WHERE t.run_id=r.id AND t.state='unknown'))))`,
        { conversation: "title", state: "state", time: "createdAt" },
        input.sort ?? { id: "time", direction: "descending" },
        input.sortCursor,
        30
    );
    return { rows: page.items, nextCursor: page.nextSortCursor };
}
