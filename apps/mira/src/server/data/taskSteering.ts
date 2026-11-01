import type { SQL, TransactionSQL } from "bun";

import { miraQueueAvailable } from "./capacity";
import { auditMira, type MiraQuery } from "./context";
import { enqueueTurn } from "./conversations";
import type { MiraClaim } from "./queue";
import { unreviewedTaskRun } from "./taskRecovery";

/**
 * Respect the operator's global pause when continuing already started task work.
 * @param query - Scheduler or claimant transaction holding the owner's controls lock.
 * @param owner - Verified task owner.
 * @returns False while automatic work is intentionally paused.
 */
export async function taskContinuationAllowed(
    query: MiraQuery,
    owner: string
): Promise<boolean> {
    const [row] = await query<{ allowed: boolean }[]>`
        SELECT NOT EXISTS (SELECT 1 FROM mira_switches WHERE owner=${owner} AND key='autonomy' AND NOT enabled) AS allowed`;
    return row?.allowed === true;
}

/**
 * Find the latest human task edit while preserving the originating account.
 * @param query - Current task transaction or executor read connection.
 * @param owner - Verified account, never supplied by task content.
 * @param taskId - Owned task reference.
 * @returns The last edit ID, or null before any human task edit.
 */
export async function latestTaskEdit(query: MiraQuery, owner: string, taskId: string) {
    const [row] = await query<{ id: string }[]>`
        SELECT id FROM mira_audit WHERE owner=${owner} AND target=${taskId}
            AND actor='human:'||owner AND action IN ('task.created','task.updated','task.progress_added')
        ORDER BY id DESC LIMIT 1`;
    return row?.id ?? null;
}

/**
 * Read a coalesced update for the exact leased task run, without copying private task content.
 * @param client - Executor database connection.
 * @param run - Current work lease; assessments cannot be steered into task execution.
 * @returns A fresh edit reference or null when no work input is pending.
 */
export async function readTaskSteering(client: SQL, run: MiraClaim) {
    if (!run.manual || !run.taskId) return null;
    const [row] = await client<{ id: string }[]>`
        SELECT a.id FROM mira_runs r JOIN mira_tasks t ON t.id=r.task_id AND t.owner=r.owner
        JOIN LATERAL (
            SELECT id FROM mira_audit WHERE owner=r.owner AND target=t.id::text
                AND actor='human:'||owner AND action IN ('task.created','task.updated','task.progress_added')
                AND (r.task_change_id IS NULL OR id>r.task_change_id)
            ORDER BY id DESC LIMIT 1
        ) a ON true
        WHERE r.id=${run.id} AND r.owner=${run.owner} AND r.lease_token=${run.leaseToken}
            AND r.state='running' AND NOT r.cancel_requested AND r.lease_expires_at>clock_timestamp()
            AND t.deleted_at IS NULL AND t.assignee='mira' AND t.status NOT IN ('blocked','done')
            AND (t.work_stopped_at IS NULL OR t.work_stopped_at<r.created_at)`;
    return row ?? null;
}

/**
 * Record provider acknowledgement only for the same live work lease.
 * @param client - Executor database connection.
 * @param run - Lease that sent the steering request.
 * @param editId - Exact acknowledged human edit; newer edits remain pending.
 * @returns Whether the durable cursor was advanced while authority was still valid.
 */
export async function acknowledgeTaskSteering(
    client: SQL,
    run: MiraClaim,
    editId: string
) {
    const rows = await client<{ id: string }[]>`
        UPDATE mira_runs SET task_change_id=${editId}
        WHERE id=${run.id} AND owner=${run.owner} AND lease_token=${run.leaseToken}
            AND state='running' AND NOT cancel_requested AND lease_expires_at>clock_timestamp()
            AND (task_change_id IS NULL OR task_change_id<${editId}::uuid) RETURNING id`;
    return rows.length === 1;
}

/**
 * Discover automatic starts, explicit unblock requests and late edits after the durable round-robin cursor.
 * @param query - Scheduler transaction holding the global scheduler lock and a stable cursor.
 * @param now - Millisecond scheduler clock; include that entire clock bucket, with a one-day expiry.
 * @returns At most twenty operator-authorized task requests, wrapping to older requests after the cursor.
 */
export async function pendingTaskContinuations(query: MiraQuery, now: Date) {
    return query<
        {
            id: string;
            owner: string;
            taskId: string;
            runId: string | null;
            conversationId: string | null;
            action: string;
            budget: number;
        }[]
    >`
        WITH edits AS (
            SELECT DISTINCT ON (a.owner,a.target,CASE WHEN a.action IN ('task.resume_requested','task.auto_start_requested') THEN a.action ELSE 'edit' END) a.id,a.owner,a.target,a.action,a.created_at
            FROM mira_audit a
            WHERE a.actor='human:'||a.owner
                AND a.action IN ('task.auto_start_requested','task.resume_requested','task.updated','task.progress_added')
                AND a.created_at>${new Date(now.getTime() - 86_400_000)} AND a.created_at<${new Date(now.getTime() + 1)}
            ORDER BY a.owner,a.target,CASE WHEN a.action IN ('task.resume_requested','task.auto_start_requested') THEN a.action ELSE 'edit' END,a.id DESC
        )
        SELECT a.id,a.owner,t.id AS "taskId",r.id AS "runId",t.conversation_id AS "conversationId",a.action,COALESCE(r.budget_seconds,300) AS budget
        FROM edits a JOIN mira_tasks t ON t.id::text=a.target AND t.owner=a.owner
        LEFT JOIN LATERAL (
            SELECT * FROM mira_runs WHERE owner=t.owner AND task_id=t.id AND manual
                AND automation_id IS NULL AND conversation_id=t.conversation_id
            ORDER BY id DESC LIMIT 1
        ) r ON true
        LEFT JOIN mira_conversations c ON c.id=t.conversation_id AND c.owner=t.owner
        WHERE t.deleted_at IS NULL AND t.assignee='mira' AND t.status NOT IN ('blocked','done')
            AND (t.conversation_id IS NULL OR (c.id IS NOT NULL AND c.deleted_at IS NULL AND c.archived_at IS NULL))
            AND ((a.action='task.auto_start_requested' AND t.auto_start
                AND (t.work_stopped_at IS NULL OR t.work_stopped_at<=a.created_at)
                AND NOT EXISTS (SELECT 1 FROM mira_audit requested WHERE requested.owner=t.owner AND requested.target=t.id::text
                    AND requested.actor='human:'||requested.owner AND requested.action='task.run_requested' AND requested.created_at>=a.created_at)
                AND NOT EXISTS (SELECT 1 FROM mira_runs newer WHERE newer.owner=t.owner AND newer.task_id=t.id AND newer.manual AND newer.created_at>a.created_at))
            OR (a.action<>'task.auto_start_requested' AND r.created_at<=a.created_at
            AND EXISTS (SELECT 1 FROM mira_audit started WHERE started.owner=t.owner AND started.target=t.id::text
                AND ((started.actor='human:'||started.owner AND started.action='task.run_requested') OR (started.actor='mira:scheduler' AND started.action='task.auto_started')) AND started.created_at<=a.created_at)
            AND ((a.action='task.resume_requested' AND t.status='in_progress')
                OR (r.state='completed' AND a.id>r.task_change_id
                    AND a.created_at>=r.started_at AND a.created_at<=r.finished_at
                    AND (t.work_stopped_at IS NULL OR t.work_stopped_at<r.created_at)))))
            AND NOT EXISTS (SELECT 1 FROM mira_runs used WHERE used.request_key=a.owner||':'||a.id::text)
            AND NOT EXISTS (SELECT 1 FROM mira_audit stopped WHERE stopped.owner=a.owner
                AND stopped.target=r.id::text AND stopped.action='run.cancel_requested' AND stopped.created_at>=a.created_at)
        ORDER BY CASE WHEN a.id>COALESCE(
            (SELECT after_id FROM mira_task_continuation_cursor WHERE id=1),
            '00000000-0000-0000-0000-000000000000'::uuid) THEN 0 ELSE 1 END,a.id LIMIT 20`;
}

/**
 * Start or continue operator-authorized task work once, reusing its conversation.
 * @param query - Scheduler transaction with all candidate owners' controls locked first.
 * @param now - Scheduler clock used for bounded discovery.
 * @param owners - Owners already locked before task or conversation rows.
 * @returns The number of newly queued automatic starts and continuations.
 */
export async function scheduleTaskContinuations(
    query: TransactionSQL,
    now: Date,
    owners: readonly string[]
) {
    let queued = 0;
    const candidates = await pendingTaskContinuations(query, now);
    for (const input of candidates) {
        if (
            !owners.includes(input.owner) ||
            !(await taskContinuationAllowed(query, input.owner))
        )
            continue;
        const [lock] = await query<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${`mira:task:${input.owner}:${input.taskId}`},0)) AS acquired`;
        if (!lock?.acquired) continue;
        const [conversation] = input.conversationId
            ? await query<{ id: string }[]>`
            SELECT id FROM mira_conversations WHERE id=${input.conversationId} AND owner=${input.owner}
                AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`
            : [];
        if (input.conversationId && !conversation) continue;
        await query`SELECT id FROM mira_tasks WHERE id=${input.taskId} AND owner=${input.owner} FOR UPDATE`;
        const candidates = await pendingTaskContinuations(query, now);
        const current = candidates.find(
            (row) =>
                row.id === input.id &&
                row.runId === input.runId &&
                row.conversationId === input.conversationId
        );
        if (!current) continue;
        const [busy] = await query<{ id: string }[]>`
            SELECT id FROM mira_runs WHERE owner=${input.owner} AND (task_id=${input.taskId} OR conversation_id=${input.conversationId}) AND state IN ('queued','running') LIMIT 1`;
        if (
            busy ||
            (await unreviewedTaskRun(query, input.owner, input.taskId)) ||
            !(await miraQueueAvailable(query, input.owner, false))
        )
            continue;
        const automaticStart = input.action === "task.auto_start_requested";
        const conversationId = input.conversationId ?? Bun.randomUUIDv7();
        if (!input.conversationId) {
            await query`INSERT INTO mira_conversations (id,owner,title) VALUES (${conversationId},${input.owner},${`Task ${input.taskId.slice(0, 8)}`})`;
            await query`UPDATE mira_tasks SET conversation_id=${conversationId},version=version+1,updated_at=now() WHERE id=${input.taskId} AND owner=${input.owner}`;
        }
        const run = await enqueueTurn(
            query,
            { owner: input.owner, actor: `human:${input.owner}` },
            {
                conversationId,
                requestId: input.id,
                attachmentIds: [],
                text: automaticStart
                    ? `Start or continue task ${input.taskId} using the automatic start selected by the operator. Read the current saved task and its progress before working. Reconcile existing results instead of replaying actions. Record verified progress and blockers. Keep task status separate from run outcome. This grants no new external, computer, browser, spending, publication or deployment permissions.`
                    : `Continue the already started task ${input.taskId}. ${input.action === "task.resume_requested" ? "The operator moved it from Blocked to In progress." : "The operator changed the task while your previous turn was ending."} Read the current saved task and its latest progress before continuing. Preserve the existing work and reconcile verified results; do not restart or replay completed actions. This update grants no new external, computer, browser, spending, publication or deployment permissions.`,
            },
            { taskId: input.taskId, manual: true, budgetSeconds: input.budget }
        );
        await query`UPDATE mira_runs SET task_resumed=true,task_auto_started=${automaticStart},priority=0,created_at=clock_timestamp() WHERE id=${run.id}`;
        if (automaticStart) {
            await auditMira(
                query,
                { owner: input.owner, actor: "mira:scheduler" },
                "task.auto_started",
                input.taskId
            );
            await query`INSERT INTO mira_progress(id,task_id,actor,content) VALUES (${Bun.randomUUIDv7()},${input.taskId},'mira:scheduler','Started work using the automatic start selected by the operator.')`;
        }
        queued++;
    }
    const last = candidates.at(-1);
    if (last) {
        // The scheduler lock serializes this round-robin position. Advance even when
        // every request is paused, full, uncertain or busy; none is consumed by deferral.
        await query`INSERT INTO mira_task_continuation_cursor(id,after_id) VALUES (1,${last.id})
            ON CONFLICT(id) DO UPDATE SET after_id=EXCLUDED.after_id`;
    }
    return queued;
}
