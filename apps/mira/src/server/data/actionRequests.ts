import type { MiraActionCursor } from "@homelab/contracts/mira";

import { readMiraCode } from "./code";
import type { MiraContext } from "./context";
import { readMiraDaytona } from "./daytona";
import { readMiraMail } from "./mail";
import { readMiraPublication } from "./publications";
import { readMiraSocial } from "./social";

type ActionKind = MiraActionCursor["kind"];

/**
 * Read one page of conversation action summaries, with outstanding actions first.
 * @param context - Authenticated owner and database connection.
 * @param conversationId - Current conversation, or absent for actions without an accessible Chat conversation.
 * @param before - Original sort tuple from the preceding page, unaffected by later state changes.
 * @returns Bounded summaries and a cursor; exact content is read only when opened.
 */
export async function listMiraActionRequests(
    context: MiraContext,
    conversationId?: string,
    before?: MiraActionCursor
) {
    const rows = await context.client<(MiraActionCursor & { state: string })[]>`
        WITH actions AS (
            SELECT id,'code' AS kind,created_at,state,owner,conversation_id FROM mira_code_publications
            UNION ALL SELECT id,'job',created_at,CASE WHEN cleanup='pending' THEN 'needs_attention' ELSE state END,owner,conversation_id FROM mira_daytona_jobs
            UNION ALL SELECT id,'mail',created_at,state,owner,conversation_id FROM mira_mail_drafts
            UNION ALL SELECT id,'publication',created_at,state,owner,conversation_id FROM mira_publications
            UNION ALL SELECT id,'social',created_at,state,owner,conversation_id FROM mira_social_drafts
        ), owned AS (
            SELECT id,kind,state,created_at,
                state IN ('draft','queued','running','sending','publishing','verification_required','queued_verification','verifying','needs_attention') AS pending
            FROM actions WHERE owner=${context.owner} AND (
                conversation_id=${conversationId ?? null}::uuid
                OR NOT EXISTS (
                    SELECT 1 FROM mira_conversations c
                    WHERE c.id=actions.conversation_id AND c.owner=${context.owner} AND c.deleted_at IS NULL
                    AND (NOT EXISTS (SELECT 1 FROM mira_runs r WHERE r.conversation_id=c.id AND NOT r.manual)
                        OR EXISTS (SELECT 1 FROM mira_runs r WHERE r.conversation_id=c.id AND r.manual))
                )
            )
        )
        SELECT id,kind,state,pending,
            to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM owned
        WHERE ${before?.id ?? null}::uuid IS NULL OR (pending,created_at,id,kind)<(
            ${before?.pending ?? null}::boolean,${before?.createdAt ?? null}::timestamptz,
            ${before?.id ?? null}::uuid,${before?.kind ?? null}::text
        )
        ORDER BY pending DESC,created_at DESC,id DESC,kind DESC LIMIT 51`;
    const page = rows.slice(0, 50);
    const last = page.at(-1);
    return {
        rows: page,
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
