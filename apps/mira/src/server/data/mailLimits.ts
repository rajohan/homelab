import { publishNotification } from "@homelab/notifications";
import type { SQL, TransactionSQL } from "bun";

export const miraMailLimits = {
    hourlyEvents: 60,
    dailyEvents: 250,
    retainedEvents: 1000,
    retentionDays: 7,
    dailyRuns: 24,
    dailyBudgetSeconds: 1800,
    runBudgetSeconds: 120,
    subscribers: 10,
} as const;

async function warn(query: TransactionSQL, owner: string, kind: "events" | "runs") {
    const [enabled] = await query<
        { allowed: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM mira_switches WHERE owner=${owner} AND key='integration:agentmail' AND enabled) AND NOT EXISTS(SELECT 1 FROM mira_switches WHERE owner=${owner} AND key='autonomy' AND NOT enabled) AS allowed`;
    if (!enabled?.allowed) return;
    const identity = new Bun.CryptoHasher("sha256").update(owner).digest("hex");
    const [clock] = await query<
        { day: string }[]
    >`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day`;
    await publishNotification(
        query,
        "mira",
        {
            key: `mail-limit:${identity}:${kind}:${clock!.day}`,
            title: "AgentMail processing limit reached",
            message:
                kind === "events"
                    ? "New mail triggers exceeded the event allowance and were skipped. Messages remain in AgentMail; review the inbox manually."
                    : "Mail-triggered work exceeded the automatic run allowance and was skipped. Review the inbox manually if needed.",
            severity: "warning",
            destination: "mira",
        },
        `human:${owner}`
    );
}

/**
 * Bound new mail references using server receipt time under the owner's admission lock.
 * @param query - Producer transaction already holding the owner's controls lock.
 * @param owner - Provisioned recipient account.
 * @returns Whether another distinct message may be retained; retries do not call this gate.
 */
export async function admitMiraMailEvent(
    query: TransactionSQL,
    owner: string
): Promise<boolean> {
    const [usage] = await query<
        { hourly: number; daily: number; retained: number }[]
    >`SELECT count(*) FILTER (WHERE received_at > now()-interval '1 hour')::int AS hourly,count(*) FILTER (WHERE received_at > now()-interval '24 hours')::int AS daily,count(*)::int AS retained FROM mira_events WHERE owner=${owner} AND kind='agentmail'`;
    const allowed = Boolean(
        usage &&
        usage.hourly < miraMailLimits.hourlyEvents &&
        usage.daily < miraMailLimits.dailyEvents &&
        usage.retained < miraMailLimits.retainedEvents
    );
    if (!allowed) await warn(query, owner, "events");
    return allowed;
}

/**
 * Reserve conservative inference time across all automatic mail subscribers for one account.
 * @param query - Globally serialized scheduler transaction; queued runs count immediately.
 * @param owner - Mail recipient account.
 * @param requestedBudget - Automation's configured maximum seconds.
 * @returns The capped run budget, or null when the rolling daily allowance is exhausted.
 */
export async function admitMiraMailRun(
    query: TransactionSQL,
    owner: string,
    requestedBudget: number
): Promise<number | null> {
    const budget = Math.min(requestedBudget, miraMailLimits.runBudgetSeconds);
    const [usage] = await query<
        { total: number; seconds: number }[]
    >`SELECT count(*)::int AS total,COALESCE(sum(r.budget_seconds),0)::int AS seconds FROM mira_runs r WHERE r.owner=${owner} AND r.created_at > now()-interval '24 hours' AND EXISTS(SELECT 1 FROM mira_event_deliveries d JOIN mira_events e ON e.id=d.event_id WHERE d.run_id=r.id AND e.owner=r.owner AND e.kind='agentmail')`;
    if (
        usage &&
        usage.total < miraMailLimits.dailyRuns &&
        usage.seconds + budget <= miraMailLimits.dailyBudgetSeconds
    )
        return budget;
    await warn(query, owner, "runs");
    return null;
}

/**
 * Purge aged mail references and delivery metadata independently of provider availability.
 * @param client - Product pool; cleanup shares scheduler serialization with delivery admission.
 * @returns Number of event references removed in this bounded batch; run history remains.
 */
export async function cleanupMiraMailEvents(client: SQL): Promise<number> {
    return client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended('homelab:mira:scheduler',0))`;
        const expired = await query<
            { id: string; owner: string }[]
        >`SELECT id,owner FROM mira_events WHERE kind='agentmail' AND received_at < now()-interval '7 days' ORDER BY received_at LIMIT 1000 FOR UPDATE SKIP LOCKED`;
        for (const event of expired) {
            await query`DELETE FROM mira_event_deliveries WHERE event_id=${event.id}`;
            await query`DELETE FROM mira_audit WHERE owner=${event.owner} AND action='event.received' AND target=${event.id}`;
            await query`DELETE FROM mira_events WHERE id=${event.id}`;
        }
        return expired.length;
    });
}
