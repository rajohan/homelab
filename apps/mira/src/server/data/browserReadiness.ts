import { readBrowserAccess } from "./browserAccess";
import type { MiraContext } from "./context";

/**
 * Read informational browser readiness for the original manual job without granting authority.
 * @param context - Trusted owner and executor lease; never model-selected.
 * @returns Waiting, ready or stopped; every later command checks authority independently.
 */
export async function readMiraBrowserReadiness(context: MiraContext) {
    if (!context.run) return { state: "unavailable" as const };
    const [run] = await context.client<
        { enabled: boolean }[]
    >`SELECT coalesce(b.enabled,false) AND coalesce(a.enabled,true) AS enabled FROM mira_runs r
        JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
        LEFT JOIN mira_switches b ON b.owner=r.owner AND b.key='computer:browser'
        LEFT JOIN mira_switches a ON a.owner=r.owner AND a.key='autonomy'
        WHERE r.id=${context.run.id} AND r.owner=${context.owner} AND r.manual AND r.automation_id IS NULL
        AND r.state='running' AND NOT r.cancel_requested AND r.lease_token=${context.run.leaseToken}
        AND r.lease_expires_at>clock_timestamp() AND r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp() AND c.deleted_at IS NULL`;
    if (!run) return { state: "unavailable" as const };
    if (!run.enabled) return { state: "disabled" as const };
    const [last] = await context.client<
        { id: string }[]
    >`SELECT id FROM mira_browser_access WHERE owner=${context.owner} AND run_id=${context.run.id} AND run_lease=${context.run.leaseToken} ORDER BY created_at DESC,id DESC LIMIT 1`;
    if (!last) return { state: "waiting" as const };
    const access = await readBrowserAccess(context.client, context.owner, last.id);
    if (!access?.available || !access.policy) return { state: "stopped" as const };
    if (access.controller === "human") return { state: "human" as const };
    const attachments = await context.client<
        { id: string; name: string; mediaType: string; bytes: number }[]
    >`
        SELECT f.id,f.name,f.media_type AS "mediaType",f.bytes FROM mira_runs r
        JOIN mira_messages m ON m.id=r.assistant_message_id AND m.conversation_id=r.conversation_id
        JOIN mira_attachments f ON m.attachment_ids @> jsonb_build_array(f.id::text)
        WHERE r.id=${context.run.id} AND r.owner=${context.owner} AND f.owner=r.owner
        AND f.ready_at IS NOT NULL AND f.deleted_at IS NULL ORDER BY f.created_at,f.id LIMIT 8`;
    return {
        ...(attachments.length > 0 ? { attachments } : {}),
        state: "ready" as const,
        mode: access.mode,
        origins: access.policy.origins,
        initialUrl: access.policy.initialUrl,
    };
}
