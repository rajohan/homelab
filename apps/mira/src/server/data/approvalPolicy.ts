import {
    miraPermissionModeSchema,
    type MiraPermissionMode,
} from "@homelab/contracts/mira";
import type { MiraDaytonaContent } from "@homelab/contracts/miraDaytona";
import * as v from "valibot";

import { localCodeRequest } from "../sandbox/localProtocol";
import { MiraFailure, type MiraContext, type MiraQuery } from "./context";

export type MiraApprovalScope = "task" | "check" | "external";
export type MiraActionKind = "mail" | "publication" | "social" | "code" | "job";

/**
 * Classify a saved job by its exact fixed profile, never by a model-supplied label.
 * @param id - Persisted job identity.
 * @param content - Immutable approved command and files.
 * @returns Checks for a fixed Homelab profile, external for arbitrary cloud commands.
 */
export function miraJobApprovalScope(
    id: string,
    content: MiraDaytonaContent
): MiraApprovalScope {
    try {
        localCodeRequest(id, content);
        return "check";
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
    type Origin = { runId: string | null };
    let row: Origin | undefined;
    let scope: MiraApprovalScope = "external";
    switch (kind) {
        case "mail": {
            [row] = await query<
                Origin[]
            >`SELECT approval_run_id AS "runId" FROM mira_mail_drafts WHERE id=${id} AND owner=${owner}`;
            break;
        }
        case "publication": {
            [row] = await query<
                Origin[]
            >`SELECT approval_run_id AS "runId" FROM mira_publications WHERE id=${id} AND owner=${owner}`;
            break;
        }
        case "social": {
            [row] = await query<
                Origin[]
            >`SELECT approval_run_id AS "runId" FROM mira_social_drafts WHERE id=${id} AND owner=${owner}`;
            break;
        }
        case "code": {
            [row] = await query<
                Origin[]
            >`SELECT approval_run_id AS "runId" FROM mira_code_publications WHERE id=${id} AND owner=${owner}`;
            break;
        }
        case "job": {
            const [job] = await query<
                (Origin & { content: MiraDaytonaContent })[]
            >`SELECT approval_run_id AS "runId",content FROM mira_daytona_jobs WHERE id=${id} AND owner=${owner}`;
            row = job;
            if (job?.runId) scope = miraJobApprovalScope(id, job.content);
        }
    }
    return row !== undefined && miraApprovalCurrent(query, owner, row.runId, scope);
}

/**
 * Decide the fixed operation classes covered by a human-selected Chat permission mode.
 * @param mode - Validated server-owned setting, never a model tool argument.
 * @param scope - Fixed handler classification; checks exclude arbitrary commands.
 * @returns Whether the action may proceed without a separate human decision.
 */
export function miraModeAllows(
    mode: MiraPermissionMode,
    scope: MiraApprovalScope
): boolean {
    return mode === "full_access" || (mode === "approve_for_me" && scope !== "external");
}

/**
 * Read the current, frozen permission for an owned live Chat/task run.
 * @param query - Current transaction; callers serialize mutations with their existing locks.
 * @param context - Trusted tool context, including the lease token and exact actor.
 * @returns Ask unless both the queued setting and current conversation still authorize the same mode.
 */
export async function miraRunPermission(
    query: MiraQuery,
    context: MiraContext
): Promise<MiraPermissionMode> {
    if (!context.run || context.actor !== `mira:${context.run.id}`) return "ask";
    const [row] = await query<{ mode: unknown }[]>`
        SELECT r.settings->>'permissionMode' AS mode FROM mira_runs r
        JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
        WHERE r.id=${context.run.id} AND r.owner=${context.owner} AND r.lease_token=${context.run.leaseToken}
        AND r.state='running' AND NOT r.cancel_requested AND r.lease_expires_at>clock_timestamp()
        AND r.approval_revoked_at IS NULL AND r.automation_id IS NULL AND r.manual AND c.deleted_at IS NULL AND c.archived_at IS NULL
        AND c.settings->>'permissionMode'=r.settings->>'permissionMode'
        AND NOT EXISTS(SELECT 1 FROM mira_tasks t WHERE t.id=r.task_id AND t.owner=r.owner
            AND (t.deleted_at IS NOT NULL OR t.work_stopped_at>=r.created_at))`;
    const parsed = v.safeParse(miraPermissionModeSchema, row?.mode);
    return parsed.success ? parsed.output : "ask";
}

/**
 * Validate exact human approval or the current Chat's delegated action permission.
 * @param query - The existing approval transaction.
 * @param context - Human or fenced model actor; synthetic human identities are never accepted.
 * @param conversationId - Draft's actual owner-checked conversation, not a tool-supplied link.
 * @param scope - Required operation class.
 * @returns Origin run ID for delegated approvals, otherwise null for direct human consent.
 */
export async function requireMiraApproval(
    query: MiraQuery,
    context: MiraContext,
    conversationId: string | null,
    scope: MiraApprovalScope
): Promise<string | null> {
    if (!context.run && context.actor === `human:${context.owner}`) return null;
    const mode = await miraRunPermission(query, context);
    if (context.run && conversationId && miraModeAllows(mode, scope)) {
        const [row] = await query<
            { id: string }[]
        >`SELECT id FROM mira_runs WHERE id=${context.run.id} AND conversation_id=${conversationId} AND owner=${context.owner}`;
        if (row) return row.id;
    }
    throw new MiraFailure(
        "FORBIDDEN",
        "This action requires the operator's approval or the appropriate Chat permission mode."
    );
}

/**
 * Recheck delegated authority before an outbox or sandbox advances, including after the model turn.
 * @param query - Existing short dispatch transaction or read.
 * @param owner - Verified job owner.
 * @param runId - Captured approval origin; null means the existing human/policy approval path.
 * @param scope - Fixed class originally approved by this dispatcher.
 * @returns False after cancellation, permission changes, archival or task stop; never revives an interrupted run.
 */
export async function miraApprovalCurrent(
    query: MiraQuery,
    owner: string,
    runId: string | null,
    scope: MiraApprovalScope
): Promise<boolean> {
    if (runId === null) return true;
    const [row] = await query<{ mode: unknown }[]>`
        SELECT r.settings->>'permissionMode' AS mode FROM mira_runs r
        JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
        WHERE r.id=${runId} AND r.owner=${owner} AND r.approval_revoked_at IS NULL AND r.automation_id IS NULL AND r.manual
        AND NOT r.cancel_requested AND (r.state='completed' OR (r.state='running' AND r.lease_expires_at>clock_timestamp()))
        AND c.deleted_at IS NULL AND c.archived_at IS NULL
        AND c.settings->>'permissionMode'=r.settings->>'permissionMode'
        AND NOT EXISTS(SELECT 1 FROM mira_tasks t WHERE t.id=r.task_id AND t.owner=r.owner
            AND (t.deleted_at IS NOT NULL OR t.work_stopped_at>=r.created_at))`;
    const parsed = v.safeParse(miraPermissionModeSchema, row?.mode);
    return parsed.success && miraModeAllows(parsed.output, scope);
}
