import { readMiraCode } from "./code";
import type { MiraContext } from "./context";
import { readMiraDaytona } from "./daytona";
import { readMiraMail } from "./mail";
import { readMiraPublication } from "./publications";
import { readMiraSocial } from "./social";

/**
 * Read outstanding conversation actions for the existing Chat request controls.
 * @returns Oldest outstanding owned actions, with resolved actions omitted.
 */
export async function listMiraActionRequests(
    context: MiraContext,
    conversationId: string
) {
    const rows = await context.client<
        { id: string; kind: "code" | "job" | "mail" | "publication" | "social" }[]
    >`
        SELECT id,kind FROM (
            SELECT id,'code' AS kind,created_at,state,owner,conversation_id FROM mira_code_publications
            UNION ALL SELECT id,'job',created_at,CASE WHEN cleanup='pending' THEN 'needs_attention' ELSE state END,owner,conversation_id FROM mira_daytona_jobs
            UNION ALL SELECT id,'mail',created_at,state,owner,conversation_id FROM mira_mail_drafts
            UNION ALL SELECT id,'publication',created_at,state,owner,conversation_id FROM mira_publications
            UNION ALL SELECT id,'social',created_at,state,owner,conversation_id FROM mira_social_drafts
        ) actions
        WHERE owner=${context.owner} AND conversation_id=${conversationId}::uuid
        AND state IN ('draft','queued','running','sending','publishing','verification_required','queued_verification','needs_attention')
        ORDER BY created_at,id,kind LIMIT 100`;
    return Promise.all(
        rows.map(async ({ id, kind }) => {
            switch (kind) {
                case "code": {
                    return {
                        kind,
                        draft: await readMiraCode(context.client, context.owner, id),
                    };
                }
                case "job": {
                    return {
                        kind,
                        draft: await readMiraDaytona(context.client, context.owner, id),
                    };
                }
                case "mail": {
                    return {
                        kind,
                        draft: await readMiraMail(context.client, context.owner, id),
                    };
                }
                case "publication": {
                    return {
                        kind,
                        draft: await readMiraPublication(
                            context.client,
                            context.owner,
                            id
                        ),
                    };
                }
                case "social": {
                    return {
                        kind,
                        draft: await readMiraSocial(context.client, context.owner, id),
                    };
                }
            }
        })
    );
}
