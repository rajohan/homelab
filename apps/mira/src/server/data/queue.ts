import type { MiraActivity, MiraRunSummary, MiraSchedule } from "@homelab/contracts/mira";
import type { SQL, TransactionSQL } from "bun";

import {
    miraDependenciesAllowed,
    miraRunAllowed,
    nextMiraOccurrence,
    resumeMiraControls,
} from "./automations";
import { miraQueueAvailable } from "./capacity";
import { auditMira, type MiraContext } from "./context";
import { enqueueTurn } from "./conversations";
import { scheduleMiraEvents } from "./events";
import { miraObservationFingerprint, notifyMiraRun } from "./notifications";

export interface MiraClaim {
    id: string;
    owner: string;
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
    automationId: string | null;
    taskId: string | null;
    leaseToken: string;
    budgetSeconds: number;
    manual: boolean;
    deadlineAt?: number;
}

/**
 * Reconcile lost run ownership without requiring an authenticated inference provider.
 * @param client - Executor database pool; no new work is claimed by this operation.
 * @returns The number of expired runs whose outcomes now require review.
 */
export async function reconcileMiraRuns(client: SQL): Promise<number> {
    return client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended('homelab:mira:claim', 0))`;
        return reconcileExpired(query);
    });
}

async function reconcileExpired(query: TransactionSQL): Promise<number> {
    const expired = await query<
        { id: string; assistantMessageId: string; owner: string }[]
    >`UPDATE mira_runs SET state = 'needs_attention', message = 'The executor disconnected. Review this run before continuing; actions were not replayed.', finished_at = now() WHERE state = 'running' AND lease_expires_at < now() RETURNING id, owner, assistant_message_id AS "assistantMessageId"`;
    for (const run of expired) {
        await notifyMiraRun(query, run.id);
        await query`UPDATE mira_messages SET state = 'failed' WHERE id = ${run.assistantMessageId}`;
        await query`UPDATE mira_tool_receipts SET state = 'unknown', message = 'Executor disconnected; reconcile before retrying.' WHERE run_id = ${run.id} AND state = 'running'`;
        await auditMira(
            query,
            { owner: run.owner, actor: "mira:executor" },
            "run.needs_attention",
            run.id
        );
    }
    return expired.length;
}

/**
 * Claim separate agent capacity, reserving one lane for user-started conversations.
 * @param client - Mira's bounded database pool, separate from infrastructure workers.
 * @param workerId - Current executor process identity.
 * @param lane - Foreground capacity never runs scheduled work.
 * @returns One leased run, or null when this lane is busy or has no eligible work.
 */
export async function claimMiraRun(
    client: SQL,
    workerId: string,
    lane: "foreground" | "general"
): Promise<MiraClaim | null> {
    return client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended('homelab:mira:claim', 0))`;
        await reconcileExpired(query);
        const busy = await query<
            { id: string }[]
        >`SELECT id FROM mira_runs WHERE state = 'running' AND lane = ${lane}`;
        if (busy[0]) return null;
        // Bound skipped entries so deliberately disabled jobs cannot monopolize a claim.
        for (let skipped = 0; skipped < 20; skipped++) {
            const [run] = await query<
                Omit<MiraClaim, "leaseToken">[]
            >`SELECT id, owner, conversation_id AS "conversationId", user_message_id AS "userMessageId", assistant_message_id AS "assistantMessageId", automation_id AS "automationId", task_id AS "taskId", budget_seconds AS "budgetSeconds", manual FROM mira_runs WHERE state = 'queued' AND NOT cancel_requested AND (${lane === "general"} OR manual) ORDER BY priority DESC, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
            if (!run) return null;
            if (
                !(run.manual
                    ? await miraDependenciesAllowed(query, run.owner, run.automationId)
                    : await miraRunAllowed(query, run.owner, run.automationId))
            ) {
                await query`UPDATE mira_runs SET state = 'interrupted', message = 'Automation disabled before execution.', finished_at = now() WHERE id = ${run.id}`;
                await query`UPDATE mira_messages SET state = 'interrupted' WHERE id = ${run.assistantMessageId}`;
                continue;
            }
            if (run.taskId && !run.manual) {
                await query`SELECT id FROM mira_tasks WHERE id=${run.taskId} AND owner=${run.owner} FOR SHARE`;
                const [due] = await query<
                    { valid: boolean }[]
                >`SELECT EXISTS (SELECT 1 FROM mira_event_deliveries d JOIN mira_events e ON e.id=d.event_id JOIN mira_tasks t ON t.id=e.task_id AND t.owner=e.owner WHERE d.run_id=${run.id} AND e.kind='task_due' AND t.id=${run.taskId} AND t.owner=${run.owner} AND t.deleted_at IS NULL AND t.status<>'done' AND t.due_at<=now() AND e.source_key=t.id::text || ':' || t.due_at::text) AS valid`;
                if (!due?.valid) {
                    await query`UPDATE mira_runs SET state='interrupted', message='Task deadline changed before execution.', finished_at=now() WHERE id=${run.id}`;
                    await query`UPDATE mira_messages SET state='interrupted' WHERE id=${run.assistantMessageId}`;
                    continue;
                }
            }
            const deadlineAt = Date.now() + run.budgetSeconds * 1000;
            const leaseToken = crypto.randomUUID();
            await query`UPDATE mira_runs SET state = 'running', worker_id = ${workerId}, lease_token = ${leaseToken}, lease_expires_at = now() + interval '30 seconds', lane = ${lane}, started_at = now() WHERE id = ${run.id}`;
            await query`UPDATE mira_messages SET state = 'streaming' WHERE id = ${run.assistantMessageId}`;
            await auditMira(
                query,
                { owner: run.owner, actor: `mira:${run.id}` },
                "run.started",
                run.id
            );
            return { ...run, leaseToken, deadlineAt };
        }
        return null;
    });
}

/**
 * Renew authority only for the current lease and recheck explicit cancellation.
 * @param client - Executor database pool.
 * @param run - Claimed run and opaque fencing token.
 * @returns Whether the active provider work may continue.
 */
export async function renewMiraRun(client: SQL, run: MiraClaim): Promise<boolean> {
    const rows = await client<
        { cancelRequested: boolean }[]
    >`UPDATE mira_runs SET lease_expires_at = now() + interval '30 seconds' WHERE id = ${run.id} AND state = 'running' AND lease_token = ${run.leaseToken} AND lease_expires_at > now() RETURNING cancel_requested AS "cancelRequested"`;
    return rows[0]?.cancelRequested === false;
}

/**
 * Persist streaming text only while this executor still owns the active run.
 * @param client - Executor database pool.
 * @param run - Current lease.
 * @param content - Bounded accumulated assistant text.
 * @returns Whether this fenced write was accepted.
 */
export async function saveMiraDelta(
    client: SQL,
    run: MiraClaim,
    content: string
): Promise<boolean> {
    const rows = await client<
        { id: string }[]
    >`UPDATE mira_messages SET content = ${content} WHERE id = ${run.assistantMessageId} AND EXISTS (SELECT 1 FROM mira_runs WHERE id = ${run.id} AND state = 'running' AND lease_token = ${run.leaseToken} AND lease_expires_at > now()) RETURNING id`;
    return rows.length === 1;
}

/**
 * Finish a leased run without overwriting the result of lease-loss reconciliation.
 * @param client - Executor database pool.
 * @param run - Current fencing token and message identity.
 * @param outcome - Observed terminal provider result or explicitly uncertain failure.
 * @returns Whether this worker still owned the run at completion.
 */
export async function finishMiraRun(
    client: SQL,
    run: MiraClaim,
    outcome: {
        state: "completed" | "interrupted" | "failed" | "needs_attention";
        text: string;
        message: string | null;
        providerTurn?: string;
    }
): Promise<boolean> {
    return client.begin(async (query) => {
        const [owned] = await query<
            { id: string; cancelRequested: boolean }[]
        >`SELECT id,cancel_requested AS "cancelRequested" FROM mira_runs WHERE id=${run.id} AND state='running' AND lease_token=${run.leaseToken} AND lease_expires_at>clock_timestamp() FOR UPDATE`;
        if (!owned) return false;
        await query`UPDATE mira_tool_receipts SET state='unknown', message='The tool receipt was not completed. Review before continuing.', finished_at=now() WHERE run_id=${run.id} AND state='running'`;
        const [receipts] = await query<
            { uncertain: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM mira_tool_receipts WHERE run_id=${run.id} AND state='unknown') AS uncertain`;
        const observed =
            outcome.state === "interrupted" && !owned.cancelRequested
                ? {
                      ...outcome,
                      state: "needs_attention" as const,
                      message:
                          "Mira was interrupted before completing this run. Review its progress before continuing; actions were not replayed.",
                  }
                : outcome;
        const terminal = receipts?.uncertain
            ? {
                  ...observed,
                  state: "needs_attention" as const,
                  message: "An action outcome needs review before continuing.",
              }
            : observed;

        const rows = await query<
            { id: string }[]
        >`UPDATE mira_runs SET state = ${terminal.state}, message = ${terminal.message}, provider_turn = COALESCE(${terminal.providerTurn ?? null}, provider_turn), finished_at = now(), lease_expires_at = NULL WHERE id = ${run.id} AND state = 'running' AND lease_token = ${run.leaseToken} AND lease_expires_at > now() RETURNING id`;
        if (!rows[0]) return false;
        await query`UPDATE mira_messages SET content = ${terminal.text}, state = ${terminal.state === "needs_attention" ? "failed" : terminal.state} WHERE id = ${run.assistantMessageId}`;
        await query`UPDATE mira_conversations SET updated_at = now() WHERE id = ${run.conversationId}`;
        if (run.automationId && terminal.state === "completed") {
            const fingerprint = await miraObservationFingerprint(query, run.owner);
            await query`UPDATE mira_runs SET observation_hash=${fingerprint} WHERE id=${run.id}`;
        }
        await notifyMiraRun(query, run.id);
        await auditMira(
            query,
            { owner: run.owner, actor: `mira:${run.id}` },
            `run.${terminal.state}`,
            run.id
        );
        return true;
    });
}

/**
 * Dispatch due recurring work once, with durable scheduling and no missed-run burst.
 * @param client - Dedicated agent executor database pool.
 * @param now - Clock supplied for deterministic scheduling tests.
 * @returns Number of newly queued runs.
 */
export async function scheduleMiraRuns(client: SQL, now = new Date()): Promise<number> {
    return client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended('homelab:mira:scheduler', 0))`;
        await resumeMiraControls(query, now);
        const due = await query<
            {
                id: string;
                owner: string;
                title: string;
                prompt: string;
                schedule: MiraSchedule;
                budgetSeconds: number;
                nextRunAt: Date;
            }[]
        >`SELECT id, owner, title, prompt, schedule, budget_seconds AS "budgetSeconds", next_run_at AS "nextRunAt" FROM mira_automations WHERE deleted_at IS NULL AND next_run_at <= ${now} ORDER BY next_run_at LIMIT 20 FOR UPDATE SKIP LOCKED`;
        let queued = await scheduleMiraEvents(query, now);
        for (const automation of due) {
            const next = nextMiraOccurrence(
                automation.schedule,
                now.getTime(),
                new Date(automation.nextRunAt).getTime()
            );
            const allowed = await miraRunAllowed(query, automation.owner, automation.id);
            if (automation.schedule.kind !== "once" || !allowed)
                await query`UPDATE mira_automations SET next_run_at = ${next} WHERE id = ${automation.id}`;
            if (!allowed) continue;
            const active = await query<
                { id: string }[]
            >`SELECT id FROM mira_runs WHERE automation_id = ${automation.id} AND state IN ('queued','running')`;
            if (active[0]) continue;
            if (!(await miraQueueAvailable(query, automation.owner, false))) continue;
            const id = Bun.randomUUIDv7();
            await query`INSERT INTO mira_conversations (id, owner, title) VALUES (${id}, ${automation.owner}, ${automation.title})`;
            await enqueueTurn(
                query,
                { owner: automation.owner, actor: "mira:scheduler" },
                {
                    conversationId: id,
                    requestId: Bun.randomUUIDv7(),
                    text: automation.prompt,
                    attachmentIds: [],
                },
                { automationId: automation.id, budgetSeconds: automation.budgetSeconds }
            );
            if (automation.schedule.kind === "once")
                await query`UPDATE mira_automations SET next_run_at = NULL WHERE id = ${automation.id}`;
            queued++;
        }
        return queued;
    });
}

/**
 * Read paginated agent executions independently of infrastructure worker capacity.
 * @param context - Authenticated product context.
 * @param before - Optional UUID cursor.
 * @param taskId - Optional owned task filter.
 * @returns Public execution outcomes and pagination metadata.
 */
export async function listMiraRuns(
    context: MiraContext,
    before?: string,
    taskId?: string
) {
    const rows = await context.client<
        MiraRunSummary[]
    >`SELECT r.id, r.conversation_id AS "conversationId", r.automation_id AS "automationId", r.task_id AS "taskId", r.state, r.cancel_requested AS "cancelRequested", r.message, r.created_at::text AS "createdAt", r.started_at::text AS "startedAt", r.finished_at::text AS "finishedAt", COALESCE(c.title, 'Deleted conversation') AS title, a.title AS "automationName", c.id IS NOT NULL AS "conversationAvailable" FROM mira_runs r LEFT JOIN mira_conversations c ON c.id = r.conversation_id AND c.owner = r.owner AND c.deleted_at IS NULL LEFT JOIN mira_automations a ON a.id = r.automation_id AND a.owner = r.owner AND a.deleted_at IS NULL WHERE r.owner = ${context.owner} AND (${taskId ?? null}::uuid IS NULL OR r.task_id = ${taskId ?? null}::uuid) AND (${before ?? null}::uuid IS NULL OR r.id < ${before ?? null}::uuid) ORDER BY r.id DESC LIMIT 30`;
    return { rows, nextCursor: rows.length === 30 ? rows.at(-1)!.id : null };
}

/**
 * Persist a coarse runtime activity without storing private reasoning or tool payloads.
 * @param client - Executor-owned database pool.
 * @param run - Current fenced lease.
 * @param activity - Observed provider stage or host-tool execution.
 * @returns Whether the current run accepted the update.
 */
export async function saveMiraActivity(
    client: SQL,
    run: MiraClaim,
    activity: MiraActivity
): Promise<boolean> {
    const rows = await client<
        { id: string }[]
    >`UPDATE mira_runs SET activity = ${JSON.stringify(activity)}::text::jsonb WHERE id = ${run.id} AND state = 'running' AND NOT cancel_requested AND lease_token = ${run.leaseToken} AND lease_expires_at > now() RETURNING id`;
    return rows.length === 1;
}
