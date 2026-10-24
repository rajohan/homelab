import type { MiraRunSummary, MiraToolReceipt } from "@homelab/contracts/mira";

import { MiraFailure, type MiraContext } from "./context";

/**
 * Inspect an owned historical run independently of the latest chat turn or chat deletion.
 * @param context - Verified operator account.
 * @param id - Durable run identity, never a provider identifier.
 * @param before - Optional older-receipt cursor within this run.
 * @returns Run metadata and a bounded page of redacted tool outcomes, newest first.
 */
export async function readMiraRun(context: MiraContext, id: string, before?: string) {
    const [run] = await context.client<
        MiraRunSummary[]
    >`SELECT r.id,r.conversation_id AS "conversationId",r.automation_id AS "automationId",r.task_id AS "taskId",r.state,r.activity,r.cancel_requested AS "cancelRequested",r.message,r.created_at::text AS "createdAt",r.started_at::text AS "startedAt",r.finished_at::text AS "finishedAt",COALESCE(c.title,'Deleted conversation') AS title,a.title AS "automationName",c.id IS NOT NULL AS "conversationAvailable" FROM mira_runs r LEFT JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner AND c.deleted_at IS NULL LEFT JOIN mira_automations a ON a.id=r.automation_id AND a.owner=r.owner AND a.deleted_at IS NULL WHERE r.id=${id} AND r.owner=${context.owner}`;
    if (!run) throw new MiraFailure("NOT_FOUND", "Run not found.");
    const rows = await context.client<
        MiraToolReceipt[]
    >`SELECT id,tool,state,message,created_at::text AS "createdAt",finished_at::text AS "finishedAt" FROM mira_tool_receipts WHERE run_id=${run.id} AND (${before ?? null}::uuid IS NULL OR id<${before ?? null}::uuid) ORDER BY id DESC LIMIT 32`;
    return { run, rows, nextCursor: rows.length === 32 ? rows.at(-1)!.id : null };
}
