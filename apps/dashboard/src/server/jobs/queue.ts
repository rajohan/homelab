import type {
    JobSummary,
    ScheduleSummary,
    ScheduleConfiguration,
} from "@homelab/contracts/operations";
import type { SQL } from "bun";
import * as v from "valibot";

import type { Transaction } from "../database/connection";
import { auditOperation } from "../operations/audit";
import { OperationFailure } from "../operations/errors";
import { jobFingerprint } from "./registry";
import { nextScheduleOccurrence } from "./scheduleTime";
import type { JobDefinition, JobHandler } from "./types";

/**
 * Serialize short queue state transitions, never external job execution.
 * @param transaction - The transaction whose lifetime owns the advisory lock.
 * @returns Completion once this database's queue admission lock is held.
 */
export async function lockQueue(transaction: Transaction): Promise<void> {
    await transaction`SELECT pg_advisory_xact_lock(1869440354, 1)`;
}

/**
 * Queue one registered job with durable replay protection and an atomic audit record.
 * @param transaction - An already locked queue transaction.
 * @param definition - Validated code-owned execution policy.
 * @param actor - Authenticated caller identity or scheduler identity.
 * @param key - Caller-scoped idempotency key.
 * @param input - Job-specific input validated by its registered handler, empty by default.
 * @param label - Optional server-derived display name; replay preserves the original name.
 * @returns The existing or newly inserted run ID.
 */
export async function enqueueJob(
    transaction: Transaction,
    definition: JobDefinition,
    actor: string,
    key: string,
    input: unknown = {},
    label: string = definition.label
): Promise<string> {
    let payload: Record<string, unknown>;
    try {
        payload = definition.validate(input);
    } catch (error) {
        if (v.isValiError(error))
            throw new OperationFailure("BAD_REQUEST", "The job input is invalid.");
        throw error;
    }
    const fingerprint = jobFingerprint(definition, payload);
    const existing = await transaction<
        { id: string; fingerprint: string }[]
    >`SELECT id, fingerprint FROM job_runs WHERE idempotency_key = ${key}`;
    if (existing[0]) {
        if (existing[0].fingerprint !== fingerprint)
            throw new OperationFailure(
                "CONFLICT",
                "The request ID was already used for a different job."
            );
        return existing[0].id;
    }
    const count = await transaction<
        { count: number }[]
    >`SELECT count(*)::int AS count FROM job_runs WHERE state IN ('queued', 'running')`;
    if ((count[0]?.count ?? 0) >= 1000)
        throw new OperationFailure(
            "TOO_MANY_REQUESTS",
            "The job queue is full. Try again later."
        );
    const id = Bun.randomUUIDv7();
    await transaction`INSERT INTO job_runs (id, action, label, resource_class, state, payload, fingerprint, idempotency_key, requested_by, attempt_limit, retry_safe, timeout_ms, resource_keys)
        VALUES (${id}, ${definition.key}, ${label}, ${definition.resourceClass}, 'queued', ${JSON.stringify(payload)}::text::jsonb, ${fingerprint}, ${key}, ${actor}, ${definition.attemptLimit}, ${definition.retrySafe}, ${definition.timeoutMs}, ${transaction.array([...definition.resourceKeys], "TEXT")})`;
    await auditOperation(transaction, actor, "jobs.enqueue", id);
    return id;
}

/**
 * Apply registered schedules and coalesce missed intervals into at most one new run.
 * @param client - The dashboard database pool.
 * @param registry - Only actions actually executable by this worker.
 * @returns Completion after due schedules advance atomically with their queue entries.
 */
export async function scheduleDueJobs(
    client: SQL,
    registry: ReadonlyMap<string, JobHandler>
): Promise<void> {
    await client.begin(async (transaction) => {
        await lockQueue(transaction);
        for (const { definition } of registry.values()) {
            if (definition.intervalSeconds === null) continue;
            const schedule: ScheduleConfiguration = {
                kind: "interval",
                intervalSeconds: definition.intervalSeconds,
            };
            await transaction`INSERT INTO job_schedules (id, action, schedule, next_run_at) VALUES (${Bun.randomUUIDv7()}, ${definition.key}, ${JSON.stringify(schedule)}::text::jsonb, now()) ON CONFLICT (action) DO NOTHING`;
        }
        const [clock] = await transaction<{ now: Date }[]>`SELECT now() AS now`;
        const now = clock?.now.getTime() ?? Date.now();
        const expired = await transaction<
            { id: string; schedule: ScheduleConfiguration }[]
        >`SELECT id, schedule FROM job_schedules WHERE NOT enabled AND disabled_until <= now() FOR UPDATE`;
        for (const schedule of expired) {
            const next = nextScheduleOccurrence(schedule.schedule, now);
            await transaction`UPDATE job_schedules SET enabled = true, disable_reason = NULL, disabled_until = NULL, next_run_at = ${next}, version = version + 1 WHERE id = ${schedule.id}`;
            await auditOperation(
                transaction,
                "system:scheduler",
                "jobs.schedule_resumed",
                schedule.id
            );
        }
        const [control] = await transaction<
            { paused: boolean }[]
        >`SELECT paused FROM worker_control WHERE id = 1`;
        if (control?.paused) return;
        const due = await transaction<
            {
                id: string;
                action: string;
                next_run_at: Date;
                schedule: ScheduleConfiguration;
            }[]
        >`SELECT id, action, next_run_at, schedule FROM job_schedules WHERE enabled AND next_run_at <= now() ORDER BY next_run_at LIMIT 50`;
        for (const schedule of due) {
            const handler = registry.get(schedule.action);
            if (!handler || handler.definition.intervalSeconds === null) continue;
            const active = await transaction<
                { id: string }[]
            >`SELECT id FROM job_runs WHERE action = ${schedule.action} AND state IN ('queued', 'running') LIMIT 1`;
            if (!active[0]) {
                try {
                    await enqueueJob(
                        transaction,
                        handler.definition,
                        "system:scheduler",
                        `schedule:${schedule.id}:${schedule.next_run_at.toISOString()}`
                    );
                } catch (error) {
                    if (
                        error instanceof OperationFailure &&
                        error.code === "TOO_MANY_REQUESTS"
                    )
                        continue;
                    throw error;
                }
            }
            const next = nextScheduleOccurrence(
                schedule.schedule,
                now,
                schedule.next_run_at.getTime()
            );
            await transaction`UPDATE job_schedules SET next_run_at = ${next} WHERE id = ${schedule.id}`;
        }
    });
}

/**
 * Read a bounded, stable page of nonsecret run summaries.
 * @param client - The dashboard database pool.
 * @param limit - Validated page size.
 * @param before - Optional UUIDv7 cursor from the previous page.
 * @param filters - Filters applied before pagination; a completion window selects an unpaginated activity sample.
 * @returns Runs ordered by completion within an activity window, otherwise by creation ID.
 */
export async function listJobs(
    client: SQL,
    limit: number,
    before: string | undefined,
    filters: JobFilters = {}
): Promise<JobSummary[]> {
    if (filters.completedWithinSeconds !== undefined && before !== undefined)
        throw new Error("Completion activity does not support creation-order cursors");
    return client<
        JobSummary[]
    >`SELECT * FROM (${jobSummaryQuery(client, filters)}) runs WHERE (${before ?? null}::uuid IS NULL OR id < ${before ?? null}::uuid) ORDER BY CASE WHEN ${filters.completedWithinSeconds ?? null}::int IS NOT NULL THEN "finishedAt"::timestamptz END DESC, id DESC LIMIT ${limit}`;
}

interface JobFilters {
    action?: string | undefined;
    view?: "all" | "active" | "recent" | undefined;
    requestedBy?: string | undefined;
    completedWithinSeconds?: number | undefined;
}

/**
 * Build the common redacted run projection before choosing a pagination order.
 * @param client - Dashboard state connection.
 * @param filters - Server-authorized action, view and optional actor boundaries.
 * @returns A lazy, composable query retaining the same filters in every sorted view.
 */
export function jobSummaryQuery(client: SQL, filters: JobFilters) {
    return client<
        JobSummary[]
    >`SELECT id, action, label, resource_class AS "resourceClass", state, attempt, attempt_limit AS "attemptLimit", requested_by AS "requestedBy", created_at::text AS "createdAt", started_at::text AS "startedAt", finished_at::text AS "finishedAt", message, cancel_requested AS "cancelRequested" FROM job_runs WHERE (${filters.action ?? null}::text IS NULL OR action = ${filters.action ?? null}) AND (${filters.requestedBy ?? null}::text IS NULL OR requested_by = ${filters.requestedBy ?? null}) AND (${filters.view ?? "all"} = 'all' OR (${filters.view ?? "all"} = 'active' AND state IN ('queued','running')) OR (${filters.view ?? "all"} = 'recent' AND state NOT IN ('queued','running'))) AND (${filters.completedWithinSeconds ?? null}::int IS NULL OR finished_at > now() - ${filters.completedWithinSeconds ?? null}::int * interval '1 second')`;
}

/**
 * Read registered schedules without exposing mutable action payloads.
 * @param client - The dashboard database pool.
 * @param registry - Code-owned labels and execution policies, never copied into editable schedules.
 * @returns The bounded schedule inventory.
 */
export async function listSchedules(
    client: SQL,
    registry: ReadonlyMap<string, JobHandler>
): Promise<ScheduleSummary[]> {
    const rows = await client<
        Pick<
            ScheduleSummary,
            | "id"
            | "action"
            | "enabled"
            | "schedule"
            | "disableReason"
            | "disabledUntil"
            | "nextRunAt"
            | "version"
            | "activeRun"
        >[]
    >`SELECT id, action, enabled, schedule, disable_reason AS "disableReason", disabled_until::text AS "disabledUntil", next_run_at::text AS "nextRunAt", version, (SELECT jsonb_build_object('id', run.id, 'state', run.state) FROM job_runs run WHERE run.action = job_schedules.action AND run.state IN ('queued','running') ORDER BY run.id LIMIT 1) AS "activeRun" FROM job_schedules ORDER BY action LIMIT 100`;
    return rows.flatMap((row) => {
        const definition = registry.get(row.action)?.definition;
        return definition
            ? [
                  {
                      ...row,
                      label: definition.label,
                      description: definition.description,
                      resourceClass: definition.resourceClass,
                      attemptLimit: definition.attemptLimit,
                      timeoutMs: definition.timeoutMs,
                      manualRunAvailable: true,
                  },
              ]
            : [];
    });
}
