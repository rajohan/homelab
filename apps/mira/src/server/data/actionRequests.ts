import { type MiraActionCursor, miraPermissionModeSchema } from "@homelab/contracts/mira";
import type { MiraDaytonaContent } from "@homelab/contracts/miraDaytona";
import * as v from "valibot";

import { miraJobApprovalScope, miraModeAllows } from "./approvalPolicy";
import { readMiraCode } from "./code";
import type { MiraContext } from "./context";
import { readMiraDaytona } from "./daytona";
import { readMiraMail } from "./mail";
import { readMiraPublication } from "./publications";
import { readMiraSocial } from "./social";

type ActionKind = MiraActionCursor["kind"];

/**
 * Read one page of drafts awaiting approval; execution history belongs in run activity.
 * @param context - Authenticated owner and database connection.
 * @param conversationId - Current conversation, or absent for actions without an accessible Chat conversation.
 * @param before - Original sort tuple from the preceding page, unaffected by later state changes.
 * @returns Human-required summaries and a cursor over the scanned drafts, including empty filtered pages.
 */
export async function listMiraActionRequests(
    context: MiraContext,
    conversationId?: string,
    before?: MiraActionCursor
) {
    // A live manual run can start covered drafts itself. This only controls presentation;
    // execution still rechecks the exact saved action and current delegated authority.
    const [delegation] = await context.client<{ mode: unknown }[]>`
        SELECT c.settings->>'permissionMode' AS mode FROM mira_conversations c
        JOIN mira_runs r ON r.conversation_id=c.id AND r.owner=c.owner
        WHERE c.id=${conversationId ?? null}::uuid AND c.owner=${context.owner}
        AND c.deleted_at IS NULL AND c.archived_at IS NULL
        AND r.manual AND r.automation_id IS NULL AND r.state='running'
        AND NOT r.cancel_requested AND r.lease_expires_at>clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM mira_tasks t WHERE t.id=r.task_id AND t.owner=r.owner
            AND (t.deleted_at IS NOT NULL OR t.work_stopped_at>=r.created_at)) LIMIT 1`;
    const permission = v.safeParse(miraPermissionModeSchema, delegation?.mode);
    const mode = permission.success ? permission.output : "ask";
    const rows = await context.client<
        (MiraActionCursor & { state: string; content: MiraDaytonaContent | null })[]
    >`
        WITH actions AS (
            SELECT id,'code' AS kind,created_at,state,owner,conversation_id,NULL::jsonb AS content FROM mira_code_publications
            UNION ALL SELECT id,'job',created_at,CASE WHEN cleanup='pending' THEN 'needs_attention' ELSE state END,owner,conversation_id,content FROM mira_daytona_jobs
            UNION ALL SELECT id,'mail',created_at,state,owner,conversation_id,NULL::jsonb FROM mira_mail_drafts
            UNION ALL SELECT id,'publication',created_at,state,owner,conversation_id,NULL::jsonb FROM mira_publications
            UNION ALL SELECT id,'social',created_at,state,owner,conversation_id,NULL::jsonb FROM mira_social_drafts
        ), owned AS (
            SELECT id,kind,state,created_at,content,true AS pending
            FROM actions WHERE state='draft' AND owner=${context.owner} AND (
                conversation_id=${conversationId ?? null}::uuid
                OR (${conversationId ?? null}::uuid IS NULL AND NOT EXISTS (
                    SELECT 1 FROM mira_conversations c
                    WHERE c.id=actions.conversation_id AND c.owner=${context.owner} AND c.deleted_at IS NULL
                    AND (NOT EXISTS (SELECT 1 FROM mira_runs r WHERE r.conversation_id=c.id AND NOT r.manual)
                        OR EXISTS (SELECT 1 FROM mira_runs r WHERE r.conversation_id=c.id AND r.manual))
                ))
            )
        )
        SELECT id,kind,state,pending,content,
            to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM owned
        WHERE ${before?.id ?? null}::uuid IS NULL OR (pending,created_at,id,kind)<(
            ${before?.pending ?? null}::boolean,${before?.createdAt ?? null}::timestamptz,
            ${before?.id ?? null}::uuid,${before?.kind ?? null}::text
        )
        ORDER BY pending DESC,created_at DESC,id DESC,kind DESC LIMIT 51`;
    const page = rows.slice(0, 50);
    const last = page.at(-1);
    return {
        rows: page
            .filter((action) => {
                if (action.kind === "job" && action.content)
                    return !miraModeAllows(
                        mode,
                        miraJobApprovalScope(action.id, action.content)
                    );
                return !miraModeAllows(
                    mode,
                    action.kind === "code" ? "code" : "external"
                );
            })
            .map(({ id, kind, state, pending, createdAt }) => ({
                id,
                kind,
                state,
                pending,
                createdAt,
            })),
        nextCursor:
            rows.length > 50 && last
                ? {
                      id: last.id,
                      kind: last.kind,
                      pending: last.pending,
                      createdAt: last.createdAt,
                  }
                : null,
    };
}

/**
 * Read the exact owned action and durable outcome when its review is opened.
 * @param context - Authenticated owner and database connection.
 * @param kind - Validated action family.
 * @param id - Selected action identity; each existing reader enforces ownership.
 * @returns The current action without granting approval or invoking its provider.
 */
export async function readMiraActionRequest(
    context: MiraContext,
    kind: ActionKind,
    id: string
) {
    switch (kind) {
        case "code": {
            return { kind, draft: await readMiraCode(context.client, context.owner, id) };
        }
        case "job": {
            return {
                kind,
                draft: await readMiraDaytona(context.client, context.owner, id),
            };
        }
        case "mail": {
            return { kind, draft: await readMiraMail(context.client, context.owner, id) };
        }
        case "publication": {
            return {
                kind,
                draft: await readMiraPublication(context.client, context.owner, id),
            };
        }
        case "social": {
            return {
                kind,
                draft: await readMiraSocial(context.client, context.owner, id),
            };
        }
    }
}
