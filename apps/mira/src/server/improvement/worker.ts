import { publishNotification } from "@homelab/notifications";
import type { SQL } from "bun";

import { miraRunAllowed } from "../data/automations";
import { codePermission, saveMiraCode } from "../data/code";
import { auditMira, MiraFailure, type MiraQuery } from "../data/context";
import { codeJobPermission, saveMiraDaytona, miraDaytonaHash } from "../data/daytona";
import { createReport } from "../data/documents";
import { saveMiraFile } from "../data/files";
import { type DaytonaExecutionConfiguration } from "../integrations/daytona/configuration";
import type { GitHubConfiguration } from "../integrations/github/configuration";
import { GitHubReader } from "../integrations/github/reader";
import type { LocalCodeBinding } from "../sandbox/localBinding";
import { daytonaEditContent } from "../sandbox/profile";
import { parseImprovement } from "./plan";
import { improvementBinding, improvementJobAllowed, improvementTarget } from "./policy";

interface Attempt {
    id: string;
    owner: string;
    runId: string;
    conversationId: string;
    automationId: string;
    state: "queued" | "checking" | "publishing";
    content: unknown;
    contentHash: string;
    bindingHash: string;
    executionTarget: string;
    token: string;
}
async function lock(query: MiraQuery, owner: string) {
    await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${owner}`},0))`;
}
/**
 * Advance one explicitly authorized improvement through source verification, fixed checks and draft publication.
 * @param client - Durable product database, independent of the originating model turn.
 * @param configuration - Qualified cloud and fixed Mira GitHub settings, never exposed to model/sandbox code.
 * @param stopping - Executor shutdown signal; repeatable local/read phases retain their lease for recovery.
 * @param directory - Private immutable attachment store.
 * @param request - Synthetic provider replacement for qualification.
 * @returns Whether an active improvement was inspected. Existing dispatchers own external writes and uncertain recovery.
 */
export async function dispatchMiraImprovement(
    client: SQL,
    configuration: {
        daytona?: DaytonaExecutionConfiguration | undefined;
        github?: GitHubConfiguration | undefined;
        localCode?: LocalCodeBinding | undefined;
    },
    stopping: AbortSignal,
    directory?: string,
    request: typeof fetch = fetch
): Promise<boolean> {
    stopping.throwIfAborted();
    const [candidate] = await client<
        { id: string; owner: string }[]
    >`SELECT id,owner FROM mira_improvements WHERE state IN ('queued','checking','publishing') AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY id LIMIT 1`;
    if (!candidate) return false;
    const job = await client.begin(async (query) => {
        await lock(query, candidate.owner);
        const [row] = await query<
            Omit<Attempt, "token">[]
        >`SELECT id,owner,run_id AS "runId",conversation_id AS "conversationId",automation_id AS "automationId",state,content,content_hash AS "contentHash",binding_hash AS "bindingHash",(SELECT coalesce(r.settings->>'executionTarget','daytona') FROM mira_runs r WHERE r.id=mira_improvements.run_id AND r.owner=mira_improvements.owner) AS "executionTarget" FROM mira_improvements WHERE id=${candidate.id} AND state IN ('queued','checking','publishing') AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) FOR UPDATE`;
        if (!row) return null;
        const token = crypto.randomUUID();
        await query`UPDATE mira_improvements SET lease_token=${token},lease_expires_at=clock_timestamp()+interval '3 minutes' WHERE id=${row.id}`;
        return { ...row, token };
    });
    if (!job) return false;
    const context = { client, owner: job.owner, actor: `improvement:${job.id}` };
    const signal = AbortSignal.any([stopping, AbortSignal.timeout(120_000)]);
    const alive = async (query: MiraQuery) => {
        const [lease] = await query<
            { id: string }[]
        >`SELECT id FROM mira_improvements WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND state=${job.state} FOR UPDATE`;
        if (!lease) throw new MiraFailure("CONFLICT", "The improvement lease changed.");
    };
    const execution = improvementTarget(configuration, job.executionTarget);
    const controlKey =
        job.executionTarget === "main" ? "code:main" : "integration:daytona";
    const allowed = async (query: MiraQuery) =>
        !!directory &&
        !!execution &&
        (job.executionTarget === "main" ||
            configuration.daytona?.executionQualified === true) &&
        improvementBinding(job.owner, configuration, job.executionTarget) ===
            job.bindingHash &&
        (await improvementJobAllowed(query, job.id)) &&
        (await codeJobPermission(query, execution)) !== null &&
        (await codePermission(query, configuration.github!)) !== null;
    const guard = async (query: MiraQuery) => {
        signal.throwIfAborted();
        await alive(query);
        if (!(await allowed(query)))
            throw new MiraFailure("FORBIDDEN", "Automatic code authority changed.");
    };
    const guardRead = () =>
        client.begin(async (query) => {
            await lock(query, job.owner);
            await guard(query);
        });
    const finish = async (
        state: "published" | "failed" | "cancelled" | "needs_attention",
        message: string,
        number?: number
    ) => {
        await client.begin(async (query) => {
            await lock(query, job.owner);
            await alive(query);
            const report = await createReport(
                { ...context, transaction: query },
                {
                    title: `Automatic code change: ${state.replaceAll("_", " ")}`,
                    kind: "improvement",
                    taskId: null,
                    markdown: `${message}\n\n[Code jobs and code changes](/jobs)${number ? `\n\n[Draft PR #${number}](https://github.com/rajohan/homelab/pull/${number})` : ""}\n\nNo merge or deployment was performed.`,
                },
                job.runId
            );
            await query`UPDATE mira_improvements SET state=${state},message=${message},report_id=${report.id},updated_at=clock_timestamp() WHERE id=${job.id}`;
            await auditMira(query, context, `improvement.${state}`, job.id);
            const [delivery] = await query<
                { mode: string; enabled: boolean }[]
            >`SELECT a.delivery AS mode,(g.enabled AND coalesce(d.enabled,false) AND coalesce(h.enabled,false)) AS enabled FROM mira_automations a JOIN mira_improvement_grants g ON g.automation_id=a.id AND g.owner=a.owner LEFT JOIN mira_switches d ON d.owner=a.owner AND d.key=${controlKey} LEFT JOIN mira_switches h ON h.owner=a.owner AND h.key='integration:github' WHERE a.id=${job.automationId} AND a.owner=${job.owner} AND a.deleted_at IS NULL`;
            if (
                state !== "cancelled" &&
                delivery?.enabled &&
                delivery.mode !== "silent" &&
                (await miraRunAllowed(query, job.owner, job.automationId))
            ) {
                await publishNotification(
                    query,
                    "mira",
                    {
                        key: `improvement:${job.id}`,
                        title:
                            state === "published"
                                ? "Mira code change ready"
                                : "Mira code change needs attention",
                        message,
                        severity: state === "published" ? "info" : "warning",
                        destination: "reports",
                    },
                    `human:${job.owner}`
                );
            }
        });
    };
    const reader = configuration.github
        ? new GitHubReader(
              configuration.github,
              Object.assign(
                  async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
                      await guardRead();
                      return request(target, init);
                  },
                  { preconnect: request.preconnect }
              )
          )
        : undefined;
    const inspectWork = async (commit: string) => {
        if (!reader)
            throw new MiraFailure("PRECONDITION_FAILED", "GitHub is not configured.");
        let page = 1;
        for (;;) {
            const work = await reader.work({ page }, signal);
            if (work.commit !== commit) throw new Error("Main changed.");
            if (work.rows.some((row) => row.author === "mira-2026"))
                throw new Error("Another Mira PR is open.");
            if (work.truncated) throw new Error("The open PR inventory was truncated.");
            if (work.nextPage === null) break;
            page = work.nextPage;
        }
    };
    try {
        const authorized = await allowed(client);
        if (!authorized) {
            await client.begin(async (query) => {
                await lock(query, job.owner);
                await alive(query);
                await query`UPDATE mira_daytona_jobs SET cancel_requested=true,outcome='cancelled',state=CASE WHEN cleanup='not_needed' THEN 'cancelled' ELSE state END,phase=CASE WHEN cleanup='not_needed' THEN 'closed' ELSE phase END,version=version+1 WHERE id=${job.id} AND state IN ('draft','queued','running','needs_attention') AND NOT cancel_requested`;
                await query`UPDATE mira_code_publications SET state='cancelled',version=version+1,message='Automatic code permission was revoked.' WHERE id=${job.id} AND state IN ('draft','queued')`;
            });
            if (job.state === "queued") {
                await finish(
                    "cancelled",
                    "Automatic coding was paused, changed or expired before code execution."
                );
                return true;
            }
        }
        if (job.state === "publishing") {
            const [publication] = await client<
                { state: string; number: number | null }[]
            >`SELECT state,number FROM mira_code_publications WHERE id=${job.id} AND owner=${job.owner}`;
            if (publication?.state === "published")
                await finish(
                    "published",
                    "The fixed check passed, sandbox cleanup was confirmed and the draft PR was verified.",
                    publication.number ?? undefined
                );
            else if (publication?.state === "needs_attention")
                await finish(
                    "needs_attention",
                    "Publication has an uncertain outcome. Inspect the existing attempt; no write will be retried."
                );
            else if (!publication || ["draft", "cancelled"].includes(publication.state))
                await finish(
                    publication?.state === "cancelled" || !authorized
                        ? "cancelled"
                        : "failed",
                    "Publication stopped before completion. Review the recorded code proposal."
                );
            return true;
        }
        if (job.state === "checking") {
            const [cloud] = await client<
                {
                    state: string;
                    cleanup: string;
                    exitCode: number | null;
                    cancelled: boolean;
                    hash: string;
                }[]
            >`SELECT state,cleanup,exit_code AS "exitCode",cancel_requested AS cancelled,content_hash AS hash FROM mira_daytona_jobs WHERE id=${job.id} AND owner=${job.owner}`;
            if (
                cloud &&
                (cloud.state === "queued" ||
                    cloud.state === "running" ||
                    cloud.cleanup === "pending")
            )
                return true;
            if (
                cloud?.state === "cancelled" ||
                (cloud?.state === "completed" && cloud.cancelled)
            ) {
                await finish(
                    "cancelled",
                    "The code check was cancelled. No PR was queued."
                );
                return true;
            }
            if (!authorized) {
                await finish(
                    cloud?.state === "needs_attention" ? "needs_attention" : "cancelled",
                    "Automatic work stopped. Review Code jobs for the recorded check and cleanup outcome."
                );
                return true;
            }
            if (
                !cloud ||
                cloud.state !== "completed" ||
                cloud.cleanup !== "confirmed" ||
                cloud.exitCode !== 0 ||
                cloud.cancelled
            ) {
                await finish(
                    cloud?.state === "needs_attention" ? "needs_attention" : "failed",
                    "The fixed check did not complete successfully with confirmed cleanup. No PR was queued."
                );
                return true;
            }
        }
        const proposal = parseImprovement(job.content);
        const hash = new Bun.CryptoHasher("sha256")
            .update(
                JSON.stringify([
                    proposal.commit,
                    proposal.title,
                    proposal.body,
                    proposal.plan,
                ])
            )
            .digest("hex");
        if (hash !== job.contentHash) throw new Error("Improvement content changed.");
        await guardRead();
        await inspectWork(proposal.commit);
        if (job.state === "queued") {
            for (const file of proposal.plan.files) {
                const original = await reader!.sourceFile(
                    { commit: proposal.commit, path: file.path },
                    signal
                );
                if (file.beforeSha256 === null) {
                    if (original.status !== "missing")
                        throw new Error("New path exists.");
                } else if (
                    original.status !== "ready" ||
                    original.sha256 !== file.beforeSha256 ||
                    original.content === file.content
                )
                    throw new Error("Original source changed or is not eligible.");
            }
            const bytes = Buffer.from(proposal.text),
                sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
            await saveMiraFile(
                context,
                directory,
                { id: job.id, name: "improvement-edits.json", bytes },
                async (query) => {
                    await guard(query);
                    const linked = await query<
                        { id: string }[]
                    >`UPDATE mira_messages SET attachment_ids=CASE WHEN attachment_ids @> ${JSON.stringify([job.id])}::text::jsonb THEN attachment_ids ELSE attachment_ids || ${JSON.stringify([job.id])}::text::jsonb END WHERE id=(SELECT assistant_message_id FROM mira_runs WHERE id=${job.runId} AND owner=${job.owner}) AND (jsonb_array_length(attachment_ids)<8 OR attachment_ids @> ${JSON.stringify([job.id])}::text::jsonb) RETURNING id`;
                    if (!linked[0])
                        throw new MiraFailure(
                            "CONFLICT",
                            "The improvement attachment is no longer available."
                        );
                }
            );
            await client.begin(async (query) => {
                await lock(query, job.owner);
                await guard(query);
                const content = daytonaEditContent(
                    { id: job.id, commit: proposal.commit, editsSha256: sha256 },
                    { id: job.id, sha256 }
                );
                await saveMiraDaytona(
                    { ...context, transaction: query },
                    {
                        id: job.id,
                        version: 0,
                        conversationId: job.conversationId,
                        taskId: null,
                        content,
                        executionTarget:
                            job.executionTarget === "main" ? "main" : "daytona",
                    },
                    execution
                );
                const stamp = await codeJobPermission(query, execution!);
                await query`UPDATE mira_daytona_jobs SET state='queued',approved_at=clock_timestamp(),control_version=${stamp},version=version+1 WHERE id=${job.id} AND state='draft'`;
                await query`UPDATE mira_improvements SET state='checking',cloud_hash=${miraDaytonaHash(content)},updated_at=clock_timestamp() WHERE id=${job.id}`;
                await auditMira(query, context, "improvement.check_queued", job.id);
            });
        } else {
            await client.begin(async (query) => {
                await lock(query, job.owner);
                await guard(query);
                const [same] = await query<
                    { id: string }[]
                >`SELECT j.id FROM mira_daytona_jobs j JOIN mira_improvements i ON i.id=j.id WHERE j.id=${job.id} AND j.content_hash=i.cloud_hash AND j.execution_target=${job.executionTarget} AND j.state='completed' AND j.cleanup='confirmed' AND j.exit_code=0 AND NOT j.cancel_requested FOR SHARE OF j`;
                if (!same)
                    throw new MiraFailure("CONFLICT", "The selected check changed.");
                const publication = await saveMiraCode(
                    { ...context, transaction: query },
                    {
                        id: job.id,
                        version: 0,
                        conversationId: job.conversationId,
                        content: {
                            checkId: job.id,
                            commit: proposal.commit,
                            title: proposal.title,
                            body: proposal.body,
                        },
                    },
                    configuration.github
                );
                const stamp = await codePermission(query, configuration.github!);
                await query`UPDATE mira_code_publications SET state='queued',approved_version=version,approved_by=${`policy:${job.automationId}`},approved_at=clock_timestamp(),control_version=${stamp},version=version+1 WHERE id=${job.id} AND state='draft'`;
                await query`UPDATE mira_improvements SET state='publishing',publication_hash=${publication.contentHash},updated_at=clock_timestamp() WHERE id=${job.id}`;
                await auditMira(query, context, "improvement.publication_queued", job.id);
            });
        }
        return true;
    } catch (error) {
        if (stopping.aborted) throw error;
        // This coordinator only reads providers and queues local records. Mutation uncertainty belongs to the outboxes.
        const [live] = await client<
            { id: string }[]
        >`SELECT id FROM mira_improvements WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND state=${job.state}`;
        if (!live) return true;
        await finish(
            "failed",
            "The improvement could not verify current authority, source, competing PRs or selected artifacts. No further step was queued. Inspect the recorded jobs before trying new work."
        );
        return true;
    } finally {
        await client`UPDATE mira_improvements SET lease_token=NULL,lease_expires_at=NULL WHERE id=${job.id} AND lease_token=${job.token}`;
    }
}
