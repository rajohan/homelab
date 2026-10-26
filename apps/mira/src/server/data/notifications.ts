import { publishNotification } from "@homelab/notifications";
import type { TransactionSQL } from "bun";

import { miraRunAllowed } from "./automations";

/**
 * Hash meaningful recorded inputs without volatile polling timestamps or Mira's own replies.
 * @param query - Claim transaction, before the model starts observing mutable state.
 * @param owner - Server-verified owner of personal tasks, memory and controls.
 * @param runId - Current run; only its owned trigger events contribute to the observation.
 * @returns An opaque digest used to suppress repeated unchanged heartbeat notices.
 */
export async function miraObservationFingerprint(
    query: TransactionSQL,
    owner: string,
    runId: string
): Promise<string> {
    // Aggregate in PostgreSQL: observations never materialize the account's full history.
    const tasks = await query<
        Record<string, unknown>[]
    >`SELECT count(*)::text AS count,coalesce(bit_xor(hashtextextended(concat_ws(':',id,version,status<>'done' AND due_at<=now()),0)),0)::text AS digest,coalesce(bit_xor(hashtextextended(concat_ws(':',id,version,status<>'done' AND due_at<=now()),1)),0)::text AS verification FROM mira_tasks WHERE owner=${owner} AND deleted_at IS NULL`;
    const progress = await query<
        Record<string, unknown>[]
    >`SELECT count(*)::text AS count,coalesce(bit_xor(hashtextextended(concat_ws(':',p.task_id,p.id),0)),0)::text AS digest,coalesce(bit_xor(hashtextextended(concat_ws(':',p.task_id,p.id),1)),0)::text AS verification FROM mira_progress p JOIN mira_tasks t ON t.id=p.task_id WHERE t.owner=${owner} AND t.deleted_at IS NULL`;
    const memory = await query<
        Record<string, unknown>[]
    >`SELECT count(*)::text AS count,coalesce(bit_xor(hashtextextended(concat_ws(':',id,version),0)),0)::text AS digest,coalesce(bit_xor(hashtextextended(concat_ws(':',id,version),1)),0)::text AS verification FROM mira_memory WHERE owner=${owner}`;
    const controls = await query<
        Record<string, unknown>[]
    >`SELECT s.key,s.enabled,s.reason,COALESCE(s.skill_resume_at,s.until) AS until,a.title AS automation FROM mira_switches s LEFT JOIN mira_automations a ON s.key='automation:'||a.id::text AND a.owner=s.owner WHERE s.owner=${owner} AND (s.key NOT LIKE 'automation:%' OR (a.id IS NOT NULL AND a.deleted_at IS NULL)) ORDER BY s.key`;
    const reports = await query<
        Record<string, unknown>[]
    >`SELECT p.id,p.version,p.archived_at FROM mira_reports p LEFT JOIN mira_runs r ON r.id=p.run_id AND r.owner=p.owner WHERE p.owner=${owner} AND p.deleted_at IS NULL AND p.run_id IS DISTINCT FROM ${runId}::uuid AND (r.automation_id IS NULL OR r.automation_id IS DISTINCT FROM (SELECT automation_id FROM mira_runs WHERE id=${runId} AND owner=${owner})) ORDER BY p.id DESC LIMIT 30`;
    const incidents = await query<
        Record<string, unknown>[]
    >`SELECT id, name, host, service, severity FROM operational_incidents WHERE state = 'active' ORDER BY id`;
    const jobs = await query<
        Record<string, unknown>[]
    >`SELECT id,label,state,created_at,finished_at FROM job_runs ORDER BY id DESC LIMIT 30`;
    const snapshots = await query<
        Record<string, unknown>[]
    >`SELECT key,captured_at FROM operation_snapshots ORDER BY key LIMIT 50`;
    const runs = await query<
        Record<string, unknown>[]
    >`SELECT id,state FROM mira_runs WHERE owner=${owner} AND id<>${runId}::uuid AND (automation_id IS NULL OR automation_id IS DISTINCT FROM (SELECT automation_id FROM mira_runs WHERE id=${runId} AND owner=${owner}) OR state IN ('failed','needs_attention','interrupted')) ORDER BY id DESC LIMIT 30`;
    const events = await query<
        { id: string }[]
    >`SELECT e.id FROM mira_event_deliveries d JOIN mira_events e ON e.id=d.event_id JOIN mira_runs r ON r.id=d.run_id WHERE r.id=${runId} AND r.owner=${owner} AND e.owner=${owner} AND d.automation_id=r.automation_id ORDER BY e.id`;
    return new Bun.CryptoHasher("sha256")
        .update(
            JSON.stringify({
                tasks,
                progress,
                memory,
                controls,
                reports,
                incidents,
                jobs,
                snapshots,
                runs,
                events,
            })
        )
        .digest("hex");
}

/**
 * Deliver private terminal notices while preserving pause intent and quiet unchanged work.
 * @param query - The transaction committing a terminal execution state.
 * @param runId - Server-owned completed or reconciled invocation.
 * @returns Completion; no notification is emitted for routine quiet or deliberately paused work.
 */
export async function notifyMiraRun(query: TransactionSQL, runId: string): Promise<void> {
    const [run] = await query<
        {
            owner: string;
            automationId: string | null;
            manual: boolean;
            state: string;
            message: string | null;
            observationHash: string | null;
            title: string | null;
            delivery: string | null;
            reportCount: number;
        }[]
    >`SELECT r.owner, r.automation_id AS "automationId", r.manual, r.state, r.message, r.observation_hash AS "observationHash", a.title, a.delivery, (SELECT count(*)::int FROM mira_reports p WHERE p.run_id = r.id AND p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM mira_improvements i WHERE i.report_id=p.id AND i.owner=p.owner)) AS "reportCount" FROM mira_runs r LEFT JOIN mira_automations a ON a.id = r.automation_id WHERE r.id = ${runId}`;
    if (!run || !["completed", "failed", "needs_attention"].includes(run.state)) return;
    if (
        run.automationId &&
        !run.manual &&
        !(await miraRunAllowed(query, run.owner, run.automationId))
    )
        return;
    const failed = run.state !== "completed";
    if (run.delivery === "silent") return;
    const key = run.automationId ?? runId;
    const failureReceipts = failed
        ? await query<
              Record<string, unknown>[]
          >`SELECT tool,input_hash,state,message FROM mira_tool_receipts WHERE run_id=${runId} ORDER BY tool,input_hash,state,message LIMIT 32`
        : [];
    const fingerprint = failed
        ? `failure:${new Bun.CryptoHasher("sha256").update(JSON.stringify({ state: run.state, message: run.message, receipts: failureReceipts })).digest("hex")}`
        : `completed:${run.observationHash ?? runId}`;
    // Serialize the baseline and publication in the same transaction, not in the model.
    await query<
        Record<string, unknown>[]
    >`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:notice:${key}`}, 0))`;
    const [previous] = await query<
        { fingerprint: string }[]
    >`SELECT fingerprint FROM mira_notice_state WHERE owner = ${run.owner} AND key = ${key}`;
    await query`INSERT INTO mira_notice_state (owner, key, fingerprint) VALUES (${run.owner}, ${key}, ${fingerprint}) ON CONFLICT (owner, key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint`;
    if ((failed || run.delivery === "changes") && previous?.fingerprint === fingerprint)
        return;
    if (!failed && (!run.automationId || run.reportCount === 0)) return;
    await publishNotification(
        query,
        "mira",
        {
            key: runId,
            title: failed ? "Mira needs attention" : "Mira report ready",
            message: failed
                ? "An execution did not complete. Review its result before retrying."
                : `${run.title?.slice(0, 160) ?? "An automation"} produced ${run.reportCount === 1 ? "a report" : "reports"}.`,
            severity: failed ? "warning" : "info",
            destination: failed ? "mira" : "reports",
        },
        `human:${run.owner}`
    );
}
