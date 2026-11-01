import { miraImprovementPolicy } from "@homelab/contracts/miraImprovement";
import type { SQL } from "bun";
import * as v from "valibot";

import { auditMira, MiraFailure } from "../data/context";
import type { MiraClaim } from "../data/queue";
import type { createGitHubTools } from "../integrations/github/tools";
import { parseImprovement } from "./plan";
import {
    improvementBinding,
    readImprovementGrant,
    type ImprovementBindings,
} from "./policy";

/**
 * Offer one durable bounded coding submission only to an explicitly authorized improvement automation.
 * @param client - Product database.
 * @param run - Fenced invocation and conversation, selected by the service.
 * @param bindings - Nonsecret qualified provider mappings.
 * @returns Local status/submission tools; dispatcher independently rechecks authority before any provider action.
 */
export function createImprovementTools(
    client: SQL,
    run: MiraClaim,
    bindings: ImprovementBindings
): ReturnType<typeof createGitHubTools> {
    const target = run.executionTarget ?? "daytona";
    const controlKey = target === "main" ? "code:main" : "integration:daytona";
    return [
        {
            name: "mira_improvement_status",
            automatic: true,
            description:
                "Read this run's bounded coding permission and any accepted improvement. A submitted change is queued work, not tested or published. Only improvement automations with explicit operator coding permission can submit; ordinary chat, brief and summary cannot. Use existing task, GitHub and source tools to inspect work before proposing edits.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
            action: async (input) => {
                v.parse(v.strictObject({}), input);
                const [automation] = await client<
                    { id: string }[]
                >`SELECT id FROM mira_automations WHERE id=${run.automationId} AND owner=${run.owner} AND kind='improvement' AND deleted_at IS NULL`;
                const grant = automation
                    ? await readImprovementGrant(
                          { client, owner: run.owner, actor: `mira:${run.id}` },
                          automation.id,
                          bindings
                      )
                    : null;
                const rows = await client<
                    { id: string; state: string; message: string | null }[]
                >`SELECT id,state,message FROM mira_improvements WHERE run_id=${run.id} AND owner=${run.owner}`;
                return { grant, policy: miraImprovementPolicy, attempt: rows[0] ?? null };
            },
        },
        {
            name: "mira_improvement_submit",
            automatic: true,
            transactional: true,
            description:
                "Submit at most one bounded repository change from this improvement automation. Inspect existing tasks/PRs, current main and applicable AGENTS.md first. Supply commit, conventional PR title, body and plan {version:1,commit,files:[{path,beforeSha256,content}]}; use null fingerprint for a new file, null content for deletion, complete replacement text otherwise. Any area of the Homelab repository, including web, Windows, backend, tests, CI workflows, deployment and documentation. At most ten text files, 64 KiB each and 256 KiB total. The service checks current source and competing Mira PRs, runs one fixed ten-minute check on the selected execution target, then opens one draft PR only on success. It never merges, deploys or retries uncertain writes. Explicit policy and integration permission are required; this queued workflow continues on the server after this model turn. Report only the returned queued status; later results appear in Code jobs, Code changes and Reports.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["commit", "title", "body", "plan"],
                properties: {
                    commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
                    title: { type: "string", maxLength: 160 },
                    body: { type: "string", maxLength: 16_000 },
                    plan: {
                        type: "object",
                        additionalProperties: false,
                        required: ["version", "commit", "files"],
                        properties: {
                            version: { const: 1 },
                            commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
                            files: {
                                type: "array",
                                minItems: 1,
                                maxItems: 10,
                                items: {
                                    type: "object",
                                    additionalProperties: false,
                                    required: ["path", "beforeSha256", "content"],
                                    properties: {
                                        path: { type: "string", maxLength: 240 },
                                        beforeSha256: { type: ["string", "null"] },
                                        content: {
                                            type: ["string", "null"],
                                            maxLength: 65_536,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            action: async (input, signal, context) => {
                signal.throwIfAborted();
                if (!context.transaction || !run.automationId)
                    throw new MiraFailure(
                        "FORBIDDEN",
                        "Automatic coding requires an authorized improvement automation."
                    );
                let proposal: ReturnType<typeof parseImprovement>;
                try {
                    proposal = parseImprovement(input);
                } catch {
                    throw new MiraFailure(
                        "BAD_REQUEST",
                        "Choose a valid bounded repository edit plan with exact original fingerprints."
                    );
                }
                const query = context.transaction;
                await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${run.owner}`},0))`;
                await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:improvement:admission',0))`;
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
                const [previous] = await query<
                    { id: string; hash: string; state: string }[]
                >`SELECT id,content_hash AS hash,state FROM mira_improvements WHERE run_id=${run.id} AND owner=${run.owner}`;
                if (previous) {
                    if (previous.hash !== hash)
                        throw new MiraFailure(
                            "CONFLICT",
                            "This run already submitted its one improvement. Inspect the existing attempt."
                        );
                    return { id: previous.id, state: previous.state };
                }
                const grant = await readImprovementGrant(
                    { ...context, transaction: query },
                    run.automationId,
                    bindings
                );
                const [controls] = await query<
                    {
                        automation: number;
                        autonomy: number;
                        daytona: number;
                        github: number;
                    }[]
                >`SELECT s.version AS automation,coalesce(u.version,1) AS autonomy,d.version AS daytona,g.version AS github FROM mira_switches s JOIN mira_switches d ON d.owner=s.owner AND d.key=${controlKey} AND d.enabled JOIN mira_switches g ON g.owner=s.owner AND g.key='integration:github' AND g.enabled LEFT JOIN mira_switches u ON u.owner=s.owner AND u.key='autonomy' WHERE s.owner=${run.owner} AND s.key='automation:'||${run.automationId}::text AND s.enabled AND coalesce(u.enabled,true) AND EXISTS(SELECT 1 FROM mira_runs r JOIN mira_improvement_grants p ON p.automation_id=r.automation_id AND p.owner=r.owner WHERE r.id=${run.id} AND r.owner=${run.owner} AND r.automation_id=${run.automationId} AND r.automation_kind='improvement' AND r.created_at>=p.updated_at AND coalesce(r.settings->>'executionTarget','daytona')=${target} AND EXISTS(SELECT 1 FROM mira_automations a WHERE a.id=r.automation_id AND a.owner=r.owner AND coalesce(a.settings->>'executionTarget','daytona')=${target}))`;
                if (!grant.enabled || !grant.current || !grant.available || !controls)
                    throw new MiraFailure(
                        "FORBIDDEN",
                        "Automatic code changes are paused, unqualified or need renewed operator permission."
                    );
                const [capacity] = await query<
                    { busy: boolean; count: number }[]
                >`SELECT EXISTS(SELECT 1 FROM mira_improvements WHERE state IN ('queued','checking','publishing','needs_attention')) AS busy,(SELECT count(*)::int FROM mira_improvements WHERE created_at>clock_timestamp()-interval '24 hours') AS count`;
                if (
                    !capacity ||
                    capacity.busy ||
                    capacity.count >= miraImprovementPolicy.attemptsPerDay
                )
                    throw new MiraFailure(
                        "PRECONDITION_FAILED",
                        "Automatic coding is limited to one active workflow and two attempts per rolling 24 hours. Review existing work."
                    );
                const id = Bun.randomUUIDv7();
                await query`INSERT INTO mira_improvements(id,owner,run_id,conversation_id,automation_id,grant_version,binding_hash,automation_control,autonomy_control,policy_version,daytona_control,github_control,content,content_hash) VALUES(${id},${run.owner},${run.id},${run.conversationId},${run.automationId},${grant.version},${improvementBinding(run.owner, bindings, target)},${controls.automation},${controls.autonomy},${miraImprovementPolicy.version},${controls.daytona},${controls.github},${JSON.stringify({ commit: proposal.commit, title: proposal.title, body: proposal.body, plan: proposal.plan })}::text::jsonb,${hash})`;
                await auditMira(query, context, "improvement.submitted", id);
                return {
                    id,
                    state: "queued",
                    message:
                        "Queued for source verification, one fixed check on the selected execution target and a draft PR if successful. No check or publication has completed yet.",
                };
            },
        },
    ];
}
