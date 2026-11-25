import type { MiraComputerScope } from "@homelab/contracts/miraComputers";

import { readComputerAccess } from "./computerAuthority";
import { type MiraContext, MiraFailure, type MiraQuery } from "./context";

export interface MiraComputerReadiness {
    state: "waiting" | "pending" | "ready" | "stopped" | "offline" | "unavailable";
    mode?: "view" | "control";
    scope?: MiraComputerScope;
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
    const [run] = await context.client<{ id: string }[]>`SELECT r.id FROM mira_runs r
        JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
        LEFT JOIN mira_switches s ON s.owner=r.owner AND s.key='autonomy'
        WHERE r.id=${context.run.id} AND r.owner=${context.owner} AND r.lease_token=${context.run.leaseToken}
        AND r.manual AND r.automation_id IS NULL AND r.state='running' AND NOT r.cancel_requested AND r.lease_expires_at>clock_timestamp()
        AND (r.budget_seconds=0 OR r.started_at+r.budget_seconds*interval '1 second'>clock_timestamp()) AND c.deleted_at IS NULL AND c.archived_at IS NULL AND coalesce(s.enabled,true)`;
    if (!run) return { state: "unavailable" };
    const grant = await runComputerGrant(context.client, context.owner, context.run);
    if (grant) return grant;
    const [online] = await context.client<
        { id: string }[]
    >`SELECT id FROM mira_computers WHERE owner=${context.owner}
        AND state='paired' AND expires_at>clock_timestamp() AND connection_expires_at>clock_timestamp() LIMIT 1`;
    return { state: online ? "waiting" : "offline" };
}

/** Read the most recent consent decision applicable to a manual run or its retained chat.
 * @param query - Database connection or the transaction serializing a new invitation.
 * @param owner - Verified owner of the run and computer.
 * @param run - Current run identity and lease.
 * @returns An effective grant or a decision that must be respected for this run.
 */
export async function runComputerGrant(
    query: MiraQuery,
    owner: string,
    run: { id: string; leaseToken: string }
): Promise<MiraComputerReadiness | undefined> {
    const [last] = await query<
        { id: string; sameRun: boolean; stoppedDuringRun: boolean }[]
    >`
        SELECT g.id, g.run_id=current_run.id AS "sameRun",
            coalesce(g.stopped_at>=current_run.started_at,false) AS "stoppedDuringRun"
        FROM mira_runs current_run
        JOIN mira_runs original ON original.owner=current_run.owner AND original.conversation_id=current_run.conversation_id
        JOIN mira_computer_access g ON g.run_id=original.id AND g.owner=current_run.owner
        WHERE current_run.id=${run.id} AND current_run.owner=${owner}
            AND (g.run_id=current_run.id OR g.keep_open)
        ORDER BY g.created_at DESC,g.id DESC LIMIT 1`;
    if (!last) return;
    const access = await readComputerAccess(query, owner, last.id);
    if (access?.available && (access.keepOpen || access.runLease === run.leaseToken))
        return access.state === "active"
            ? {
                  state: "ready",
                  mode: access.mode,
                  ...(access.scope === "window" ? {} : { scope: access.scope }),
              }
            : { state: "pending" };
    if (last.sameRun || last.stoppedDuringRun) return { state: "stopped" };
    return undefined;
}
