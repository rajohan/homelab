import type { SQL, TransactionSQL } from "bun";

import { miraQueueAvailable } from "./capacity";
import type { MiraQuery } from "./context";
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
 * Discover explicit unblock requests and edits that raced the end of active work.
 * @param query - Scheduler discovery or its transaction.
 * @param now - Scheduler clock; requests older than one day never replay.
 * @returns At most twenty requests linked to an already user-started task conversation.
 */
export async function pendingTaskContinuations(query: MiraQuery, now: Date) {
    return query<
        {
            id: string;
            owner: string;
            taskId: string;
            runId: string;
            conversationId: string;
            action: string;
            budget: number;
        }[]
    >`
        WITH edits AS (
            SELECT DISTINCT ON (a.owner,a.target,a.action='task.resume_requested') a.id,a.owner,a.target,a.action,a.created_at
            FROM mira_audit a
            WHERE a.actor='human:'||a.owner
                AND a.action IN ('task.resume_requested','task.updated','task.progress_added')
                AND a.created_at>${new Date(now.getTime() - 86_400_000)} AND a.created_at<=${now}
            ORDER BY a.owner,a.target,a.action='task.resume_requested',a.id DESC
        )
        SELECT a.id,a.owner,t.id AS "taskId",r.id AS "runId",r.conversation_id AS "conversationId",a.action,r.budget_seconds AS budget
        FROM edits a JOIN mira_tasks t ON t.id::text=a.target AND t.owner=a.owner
        JOIN LATERAL (
            SELECT * FROM mira_runs WHERE owner=t.owner AND task_id=t.id AND manual
                AND automation_id IS NULL AND conversation_id=t.conversation_id
            ORDER BY id DESC LIMIT 1
        ) r ON true
        JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
        WHERE t.deleted_at IS NULL AND t.assignee='mira' AND t.status NOT IN ('blocked','done')
            AND c.deleted_at IS NULL AND c.archived_at IS NULL
            AND r.created_at<=a.created_at
            AND EXISTS (SELECT 1 FROM mira_audit started WHERE started.owner=t.owner AND started.target=t.id::text
                AND started.actor='human:'||started.owner AND started.action='task.run_requested' AND started.created_at<=a.created_at)
            AND ((a.action='task.resume_requested' AND t.status='in_progress')
                OR (r.state='completed' AND a.id>r.task_change_id
                    AND a.created_at>=r.started_at AND a.created_at<=r.finished_at
                    AND (t.work_stopped_at IS NULL OR t.work_stopped_at<r.created_at)))
            AND NOT EXISTS (SELECT 1 FROM mira_runs used WHERE used.request_key=a.owner||':'||a.id::text)
            AND NOT EXISTS (SELECT 1 FROM mira_audit stopped WHERE stopped.owner=a.owner
                AND stopped.target=r.id::text AND stopped.action='run.cancel_requested' AND stopped.created_at>=a.created_at)
        ORDER BY a.id LIMIT 20`;
}

/**
 * Continue previously authorized task work once, in its existing conversation.
 * @param query - Scheduler transaction with all candidate owners' controls locked first.
 * @param now - Scheduler clock used for bounded discovery.
 * @param owners - Owners already locked before task or conversation rows.
 * @returns The number of newly queued continuations, never new task starts.
 */
export async function scheduleTaskContinuations(
    query: TransactionSQL,
    now: Date,
    owners: readonly string[]
) {
    let queued = 0;
    for (const input of await pendingTaskContinuations(query, now)) {
        if (
            !owners.includes(input.owner) ||
            !(await taskContinuationAllowed(query, input.owner))
        )
            continue;
        const [lock] = await query<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${`mira:task:${input.owner}:${input.taskId}`},0)) AS acquired`;
        if (!lock?.acquired) continue;
        const [conversation] = await query<{ id: string }[]>`
            SELECT id FROM mira_conversations WHERE id=${input.conversationId} AND owner=${input.owner}
                AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`;
        if (!conversation) continue;
        await query`SELECT id FROM mira_tasks WHERE id=${input.taskId} AND owner=${input.owner} FOR UPDATE`;
        const candidates = await pendingTaskContinuations(query, now);
        const current = candidates.find(
            (row) => row.id === input.id && row.runId === input.runId
        );
        if (!current) continue;
        const [busy] = await query<{ id: string }[]>`
            SELECT id FROM mira_runs WHERE owner=${input.owner} AND (task_id=${input.taskId} OR conversation_id=${input.conversationId}) AND state IN ('queued','running') LIMIT 1`;
        if (
            busy ||
            (await unreviewedTaskRun(query, input.owner, input.taskId)) ||
            !(await miraQueueAvailable(query, input.owner, true))
        )
            continue;
        const run = await enqueueTurn(
            query,
            { owner: input.owner, actor: `human:${input.owner}` },
            {
                conversationId: input.conversationId,
                requestId: input.id,
                attachmentIds: [],
                text: `Continue the already started task ${input.taskId}. ${input.action === "task.resume_requested" ? "The operator moved it from Blocked to In progress." : "The operator changed the task while your previous turn was ending."} Read the current saved task and its latest progress before continuing. Preserve the existing work and reconcile verified results; do not restart or replay completed actions. This update grants no new external, computer, browser, spending, publication or deployment permissions.`,
            },
            { taskId: input.taskId, manual: true, budgetSeconds: input.budget }
        );
        await query`UPDATE mira_runs SET task_resumed=true WHERE id=${run.id}`;
        queued++;
    }
    return queued;
}
