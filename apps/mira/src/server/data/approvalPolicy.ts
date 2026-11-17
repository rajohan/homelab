import type { MiraDaytonaContent } from "@homelab/contracts/miraDaytona";

import { localCodeRequest } from "../sandbox/localProtocol";
import { type MiraContext, MiraFailure, type MiraQuery } from "./context";

export type MiraApprovalScope = "task" | "local_code" | "check" | "code" | "external";
export type MiraActionKind = "mail" | "publication" | "social" | "code" | "job";

/**
 * Classify a saved job by its exact fixed profile, never by a model-supplied label.
 * @param id - Persisted job identity.
 * @param content - Immutable approved command and files.
 * @param executionTarget - Persisted execution target; only the fixed local profile is freely runnable.
 * @returns Local coding, cloud checks, or external execution scope.
 */
export function miraJobApprovalScope(
    id: string,
    content: MiraDaytonaContent,
    executionTarget?: string
): MiraApprovalScope {
    try {
        localCodeRequest(id, content);
        return executionTarget === "main" ? "local_code" : "check";
    } catch {
        return "external";
    }
}

/**
 * Recheck a queued action's durable approval origin before dispatch and each external write.
 * @param query - Existing dispatch transaction, serialized with permission edits.
 * @param owner - Verified account owning this action.
 * @param kind - Fixed dispatcher kind, never a SQL identifier supplied by a model.
 * @param id - Saved action identity.
 * @returns Whether direct human/policy approval or current delegated authority remains valid.
 */
export async function miraActionApproval(
    query: MiraQuery,
    owner: string,
    kind: MiraActionKind,
    id: string
): Promise<boolean> {
    type Origin = { runId: string | null; approvedAt: string | null };
    let row: Origin | undefined;
    switch (kind) {
        case "mail": {
            [row] = await query<
                Origin[]
            >`SELECT approval_run_id AS "runId",approved_at::text AS "approvedAt" FROM mira_mail_drafts WHERE id=${id} AND owner=${owner}`;
            break;
        }
        case "publication": {
            [row] = await query<
                Origin[]
            >`SELECT approval_run_id AS "runId",approved_at::text AS "approvedAt" FROM mira_publications WHERE id=${id} AND owner=${owner}`;
            break;
        }
        case "social": {
            [row] = await query<
                Origin[]
            >`SELECT approval_run_id AS "runId",approved_at::text AS "approvedAt" FROM mira_social_drafts WHERE id=${id} AND owner=${owner}`;
            break;
        }
        case "code": {
            [row] = await query<
                Origin[]
            >`SELECT approval_run_id AS "runId",approved_at::text AS "approvedAt" FROM mira_code_publications WHERE id=${id} AND owner=${owner}`;
            break;
        }
        case "job": {
            [row] = await query<
                Origin[]
            >`SELECT approval_run_id AS "runId",approved_at::text AS "approvedAt" FROM mira_daytona_jobs WHERE id=${id} AND owner=${owner}`;
        }
    }
    return (
        row !== undefined && miraApprovalCurrent(query, owner, row.runId, row.approvedAt)
    );
}

/**
 * Check the live, owned manual run before local work or an independent action review.
 * @param query - Current read or mutation transaction.
 * @param context - Server-created actor and fenced run, never tool arguments.
 * @returns Whether this exact manual run still has authority to work.
 */
export async function miraManualRunAllowed(
    query: MiraQuery,
    context: MiraContext
): Promise<boolean> {
    if (!context.run || context.actor !== `mira:${context.run.id}`) return false;
    const [row] = await query<{ id: string }[]>`
        SELECT r.id FROM mira_runs r
        JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
        WHERE r.id=${context.run.id} AND r.owner=${context.owner} AND r.lease_token=${context.run.leaseToken}
        AND r.state='running' AND NOT r.cancel_requested AND r.lease_expires_at>clock_timestamp()
        AND r.automation_id IS NULL AND r.manual AND c.deleted_at IS NULL AND c.archived_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM mira_tasks t WHERE t.id=r.task_id AND t.owner=r.owner
            AND (t.deleted_at IS NOT NULL OR t.work_stopped_at>=r.created_at))`;
    return !!row;
}

/**
 * Validate exact human approval or the current Chat's delegated action permission.
 * @param query - The existing approval transaction.
 * @param context - Human or fenced model actor; synthetic human identities are never accepted.
 * @param conversationId - Draft's actual owner-checked conversation, not a tool-supplied link.
 * @param scope - Required operation class.
 * @param action - Exact action fingerprint required for externally reviewed operations.
 * @returns Origin run ID for delegated approvals, otherwise null for direct human consent.
 */
export async function requireMiraApproval(
    query: MiraQuery,
    context: MiraContext,
    conversationId: string | null,
    scope: MiraApprovalScope,
    action?: { id: string; contentHash: string }
): Promise<string | null> {
    if (!context.run && context.actor === `human:${context.owner}`) return null;
    const reviewed =
        scope !== "external" ||
        (action !== undefined &&
            context.reviewedAction?.id === action.id &&
            context.reviewedAction.contentHash === action.contentHash);
    if (
        context.run &&
        conversationId &&
        reviewed &&
        (await miraManualRunAllowed(query, context))
    ) {
        const [row] = await query<
            { id: string }[]
        >`SELECT id FROM mira_runs WHERE id=${context.run.id} AND conversation_id=${conversationId} AND owner=${context.owner}`;
        if (row) return row.id;
    }
    throw new MiraFailure(
        "FORBIDDEN",
        "This action requires an independent review or the operator's approval."
    );
}

/**
 * Recheck delegated authority before an outbox or sandbox advances, including after the model turn.
 * @param query - Existing short dispatch transaction or read.
 * @param owner - Verified job owner.
 * @param runId - Captured approval origin; null means the existing human/policy approval path.
 * @param approvedAt - Database approval timestamp; approvals predating the latest revocation never revive.
 * @returns False after cancellation, stale approval, archival or task stop; never revives an interrupted run.
 */
export async function miraApprovalCurrent(
    query: MiraQuery,
    owner: string,
    runId: string | null,
    approvedAt: string | null = null
): Promise<boolean> {
    if (runId === null) return true;
    const [row] = await query<{ id: string }[]>`
        SELECT r.id FROM mira_runs r
        JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
        WHERE r.id=${runId} AND r.owner=${owner} AND (r.approval_revoked_at IS NULL OR ${approvedAt}::timestamptz>r.approval_revoked_at) AND r.automation_id IS NULL AND r.manual
        AND NOT r.cancel_requested AND (r.state='completed' OR (r.state='running' AND r.lease_expires_at>clock_timestamp()))
        AND c.deleted_at IS NULL AND c.archived_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM mira_tasks t WHERE t.id=r.task_id AND t.owner=r.owner
            AND (t.deleted_at IS NOT NULL OR t.work_stopped_at>=r.created_at))`;
    return !!row;
}
