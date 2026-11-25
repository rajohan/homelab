import { controllerRestartMessages } from "@homelab/contracts/maintenance";
import type { JobSummary } from "@homelab/contracts/operations";
import type { SQL } from "bun";

import {
    activeRestartMessages,
    activeRestartSteps,
    type RestartBatch,
} from "../integrations/maintenance/batch";
import { jobSummaryQuery } from "./queue";

type Journal = {
    id: string;
    label: string;
    phase: "waiting" | "submitted" | "verified" | "refused" | "unverified";
    started: number;
};
type FeedRecord = (
    | { kind: "job"; data: JobSummary }
    | { kind: "batch"; data: RestartBatch }
    | { kind: "controller"; data: Journal }
) & { changed: string };
type RestartItem = Pick<
    JobSummary,
    "id" | "label" | "state" | "message" | "createdAt" | "finishedAt"
> & { kind: "batch" | "controller" };

const controllerStates = {
    waiting: "queued",
    submitted: "running",
    verified: "succeeded",
    refused: "failed",
    unverified: "failed",
} as const;
const batchStates = {
    waiting: "queued",
    running: "running",
    complete: "succeeded",
    attention: "failed",
} as const;

function restartItem(
    row: Exclude<FeedRecord, { kind: "job" }>,
    messages: ReadonlyMap<string, string>
): RestartItem {
    if (row.kind === "controller") {
        const { id, label, phase, started } = row.data;
        return {
            kind: row.kind,
            id,
            label: `Restart ${label}`,
            state: controllerStates[phase],
            message: controllerRestartMessages[phase],
            createdAt: new Date(started * 1000).toISOString(),
            finishedAt: phase === "waiting" || phase === "submitted" ? null : row.changed,
        };
    }
    const { id, requested, steps, phase, parent } = row.data;
    const finished = steps.filter(
        (step) =>
            step.state === "done" || step.state === "skipped" || step.state === "failed"
    ).length;
    const progress = [
        `${finished} of ${steps.length} processed`,
        ...activeRestartSteps(steps, messages).map(
            (step) => `${step.target} · ${step.message}`
        ),
    ];
    if (phase === "attention") progress.push("Review services that need attention.");
    return {
        kind: row.kind,
        id,
        label: parent ? "Post-update service restarts" : "Service restart batch",
        state: batchStates[phase],
        message: progress.join(" · "),
        createdAt: new Date(requested).toISOString(),
        finishedAt: phase === "complete" || phase === "attention" ? row.changed : null,
    };
}

/** Combine the operator's queue jobs and restart operations with current worker progress.
 * @param client - Dashboard operations database.
 * @param actor - Authenticated actor, including the owner of a triggering update job.
 * @param includeRestarts - Whether the actor may read maintenance observations.
 * @returns Active operations and the five latest completions within fifteen minutes, with each batch counted once.
 */
export async function workerActivity(
    client: SQL,
    actor: string,
    includeRestarts: boolean
) {
    const rows = await client<FeedRecord[]>`WITH batches AS MATERIALIZED (
        SELECT s.value,s.captured_at FROM operation_snapshots s
        WHERE ${includeRestarts} AND s.key LIKE 'maintenance.batch:%'
          AND (s.value->>'phase' IN ('waiting','running') OR s.captured_at >= now()-interval '15 minutes')
          AND (s.value->>'actor'=${actor} OR (s.value->>'actor'='system:updates' AND EXISTS (
            SELECT 1 FROM job_runs parent WHERE parent.id=(s.value->>'parent')::uuid AND parent.requested_by=${actor})))
    ), children AS MATERIALIZED (
        SELECT step->>'child' AS id,step->>'channel' AS channel FROM batches CROSS JOIN LATERAL jsonb_array_elements(value->'steps') step WHERE step ? 'child'
    ), entries AS (
        SELECT 'job' AS kind,to_jsonb(j) AS data,j.id::text AS id,j.state IN ('queued','running') AS active,
            coalesce(j."finishedAt",j."createdAt")::timestamptz AS changed
        FROM (${jobSummaryQuery(client, { requestedBy: actor })}) j
        WHERE (j.state IN ('queued','running') OR j."finishedAt"::timestamptz >= now()-interval '15 minutes')
          AND NOT EXISTS (SELECT 1 FROM children WHERE children.channel='job' AND children.id=j.id::text)
        UNION ALL
        SELECT 'batch',value,value->>'id',value->>'phase' IN ('waiting','running'),captured_at FROM batches
        UNION ALL
        SELECT 'controller',jsonb_build_object('id',value->>'id','label',value->>'label','phase',value->>'phase','started',(value->>'started')::bigint),
            value->>'id',value->>'phase' IN ('waiting','submitted'),captured_at
        FROM operation_snapshots s WHERE ${includeRestarts} AND key LIKE 'maintenance.proxmox.run:%' AND value->>'actor'=${actor}
          AND (value->>'phase' IN ('waiting','submitted') OR captured_at >= now()-interval '15 minutes')
          AND NOT EXISTS (SELECT 1 FROM children WHERE children.channel='controller' AND children.id=s.value->>'id')
    )
    SELECT kind,data,changed::text AS changed FROM (
        (SELECT * FROM entries WHERE active ORDER BY changed DESC,id DESC LIMIT 1000)
        UNION ALL
        (SELECT * FROM entries WHERE NOT active ORDER BY changed DESC,id DESC LIMIT 5)
    ) visible ORDER BY active DESC,visible.changed DESC,id DESC`;
    const runs: JobSummary[] = [];
    const restarts: RestartItem[] = [];
    const messages = await activeRestartMessages(
        client,
        rows.flatMap((row) => (row.kind === "batch" ? [row.data] : []))
    );
    for (const row of rows) {
        if (row.kind === "job") runs.push(row.data);
        else restarts.push(restartItem(row, messages));
    }
    return { runs, restarts };
}
