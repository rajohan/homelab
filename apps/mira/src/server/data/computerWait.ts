import { readComputerAccess } from "./computerAuthority";
import { MiraFailure, type MiraContext } from "./context";

export interface MiraComputerReadiness {
    state: "waiting" | "pending" | "ready" | "stopped" | "offline" | "unavailable";
    mode?: "view" | "control";
    scope?: "window" | "desktop";
}

/**
 * Read this manual run's effective access without exposing identities or creating authority.
 * @param context - Trusted current owner/run/lease; model arguments cannot replace it.
 * @returns Informational readiness only; each later command still checks its complete grant.
 */
export async function readMiraComputerReadiness(
    context: MiraContext
): Promise<MiraComputerReadiness> {
    if (!context.run)
        throw new MiraFailure("FORBIDDEN", "Computer readiness requires a manual run.");
    const [run] = await context.client<
        { id: string; conversationId: string; startedAt: Date }[]
    >`SELECT r.id,r.conversation_id AS "conversationId",r.started_at AS "startedAt" FROM mira_runs r
        JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
        LEFT JOIN mira_switches s ON s.owner=r.owner AND s.key='autonomy'
        WHERE r.id=${context.run.id} AND r.owner=${context.owner} AND r.lease_token=${context.run.leaseToken}
        AND r.manual AND r.automation_id IS NULL AND r.state='running' AND NOT r.cancel_requested AND r.lease_expires_at>clock_timestamp()
        AND r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp() AND c.deleted_at IS NULL AND c.archived_at IS NULL AND coalesce(s.enabled,true)`;
    if (!run) return { state: "unavailable" };
    const [last] = await context.client<
        { id: string; stoppedBeforeRun: boolean }[]
    >`SELECT g.id,(g.run_id<>${context.run.id} AND g.state='stopped'
            AND g.stopped_at<=${run.startedAt}) AS "stoppedBeforeRun"
        FROM mira_computer_access g JOIN mira_runs original ON original.id=g.run_id AND original.owner=g.owner
        WHERE g.owner=${context.owner} AND ((g.run_id=${context.run.id} AND g.run_lease=${context.run.leaseToken})
            OR (g.keep_open AND original.conversation_id=${run.conversationId}))
        ORDER BY g.created_at DESC,g.id DESC LIMIT 1`;
    // An explicit new manual turn may wait for NEW consent after an older
    // attempt ended. A stop during this run still ends its wait immediately.
    if (last && !last.stoppedBeforeRun) {
        const access = await readComputerAccess(context.client, context.owner, last.id);
        if (!access?.available || access.state === "stopped") return { state: "stopped" };
        return access.state === "active"
            ? {
                  state: "ready",
                  mode: access.mode,
                  ...(access.scope === "desktop" ? { scope: access.scope } : {}),
              }
            : { state: "pending" };
    }
    const [online] = await context.client<
        { id: string }[]
    >`SELECT id FROM mira_computers WHERE owner=${context.owner}
        AND state='paired' AND expires_at>clock_timestamp() AND connection_expires_at>clock_timestamp() LIMIT 1`;
    return { state: online ? "waiting" : "offline" };
}
