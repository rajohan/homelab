import { readMiraCode } from "./code";
import type { MiraContext } from "./context";
import { readMiraDaytona } from "./daytona";
import { readMiraMail } from "./mail";
import { readMiraPublication } from "./publications";
import { readMiraSocial } from "./social";

type ActionKind = "code" | "job" | "mail" | "publication" | "social";

/**
 * Read one page of conversation action summaries, with outstanding actions first.
 * @param context - Authenticated owner and database connection.
 * @param conversationId - Owned conversation whose actions are requested.
 * @param before - Last kind:id from the preceding page, or absent for the first page.
 * @returns Bounded summaries and a cursor; exact content is read only when opened.
 */
export async function listMiraActionRequests(
    context: MiraContext,
    conversationId: string,
    before?: string
) {
    const rows = await context.client<
        { id: string; kind: ActionKind; state: string; pending: boolean }[]
    >`
        WITH actions AS (
            SELECT id,'code' AS kind,created_at,state,owner,conversation_id FROM mira_code_publications
            UNION ALL SELECT id,'job',created_at,CASE WHEN cleanup='pending' THEN 'needs_attention' ELSE state END,owner,conversation_id FROM mira_daytona_jobs
            UNION ALL SELECT id,'mail',created_at,state,owner,conversation_id FROM mira_mail_drafts
            UNION ALL SELECT id,'publication',created_at,state,owner,conversation_id FROM mira_publications
            UNION ALL SELECT id,'social',created_at,state,owner,conversation_id FROM mira_social_drafts
        ), owned AS (
            SELECT id,kind,state,created_at,
                state IN ('draft','queued','running','sending','publishing','verification_required','queued_verification','verifying','needs_attention') AS pending
            FROM actions WHERE owner=${context.owner} AND conversation_id=${conversationId}::uuid
        )
        SELECT id,kind,state,pending FROM owned
        WHERE ${before ?? null}::text IS NULL OR (pending,created_at,id,kind)<(
            SELECT pending,created_at,id,kind FROM owned WHERE kind || ':' || id::text=${before ?? null}
        )
        ORDER BY pending DESC,created_at DESC,id DESC,kind DESC LIMIT 51`;
    const page = rows.slice(0, 50);
    const last = page.at(-1);
    return {
        rows: page,
        nextCursor: rows.length > 50 && last ? `${last.kind}:${last.id}` : null,
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
