import {
    miraImprovementPolicy,
    type MiraImprovementGrant,
    type miraImprovementGrantSchema,
    type miraImprovementResolveSchema,
} from "@homelab/contracts/miraImprovement";
import type * as v from "valibot";

import { codePermission } from "../data/code";
import {
    auditMira,
    MiraFailure,
    type MiraContext,
    type MiraQuery,
} from "../data/context";
import { daytonaPermission } from "../data/daytona";
import {
    daytonaBindingHash,
    type DaytonaBinding,
} from "../integrations/daytona/configuration";
import {
    githubBindingHash,
    type GitHubBinding,
} from "../integrations/github/configuration";

export interface ImprovementBindings {
    daytona?: DaytonaBinding | undefined;
    github?: GitHubBinding | undefined;
}

/**
 * Bind automatic code authority to one operator, fixed policy and qualified provider mappings.
 * @param owner - Verified operator.
 * @param bindings - Service-owned nonsecret account/snapshot mappings.
 * @returns Stable binding fingerprint; missing or different owners cannot authorize work.
 */
export function improvementBinding(
    owner: string,
    bindings: ImprovementBindings
): string | null {
    if (bindings.daytona?.owner !== owner || bindings.github?.owner !== owner)
        return null;
    return new Bun.CryptoHasher("sha256")
        .update(
            JSON.stringify([
                miraImprovementPolicy,
                daytonaBindingHash(bindings.daytona),
                githubBindingHash(bindings.github),
            ])
        )
        .digest("hex");
}
/**
 * Read one automation's explicit coding grant without exposing provider credentials.
 * @param context - Authenticated owner.
 * @param automationId - Owned improvement automation.
 * @param bindings - Current dashboard/executor mappings.
 * @returns Disabled default or saved grant with current qualification and version status.
 */
export async function readImprovementGrant(
    context: MiraContext,
    automationId: string,
    bindings: ImprovementBindings
): Promise<MiraImprovementGrant> {
    const query = context.transaction ?? context.client;
    const [row] = await query<
        {
            version: number;
            enabled: boolean;
            bound: string | null;
            definition: number | null;
            automationVersion: number;
        }[]
    >`SELECT coalesce(g.version,0) AS version,coalesce(g.enabled,false) AS enabled,g.binding_hash AS bound,g.automation_version AS definition,a.version AS "automationVersion" FROM mira_automations a LEFT JOIN mira_improvement_grants g ON g.automation_id=a.id AND g.owner=a.owner WHERE a.id=${automationId} AND a.owner=${context.owner} AND a.kind='improvement' AND a.deleted_at IS NULL`;
    if (!row) throw new MiraFailure("NOT_FOUND", "Improvement automation not found.");
    const binding = improvementBinding(context.owner, bindings);
    const available =
        !!binding &&
        (await daytonaPermission(query, bindings.daytona!)) !== null &&
        (await codePermission(query, bindings.github!)) !== null;
    const blocked = await blockedImprovement(query, context.owner, automationId);
    return {
        blocked,
        automationId,
        version: row.version,
        enabled: row.enabled,
        current:
            !!binding &&
            row.bound === binding &&
            row.definition === row.automationVersion,
        available,
    };
}
/**
 * Save exact human consent for the fixed automatic improvement policy; models cannot grant it.
 * @param context - Signed-in operator, without a model run.
 * @param input - Reviewed policy, expected grant and automation versions.
 * @param bindings - Qualified service mappings captured in the grant.
 * @returns Updated policy state; enabling does not start a run or allocate a sandbox.
 */
export async function saveImprovementGrant(
    context: MiraContext,
    input: v.InferOutput<typeof miraImprovementGrantSchema>,
    bindings: ImprovementBindings
) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Only the operator can allow automatic code changes."
        );
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const [automation] = await query<
            { id: string }[]
        >`SELECT id FROM mira_automations WHERE id=${input.automationId} AND owner=${context.owner} AND version=${input.automationVersion} AND kind='improvement' AND deleted_at IS NULL FOR UPDATE`;
        if (!automation)
            throw new MiraFailure(
                "CONFLICT",
                "The automation changed. Refresh and review its instructions again."
            );
        const current = await readImprovementGrant(
            { ...context, transaction: query },
            input.automationId,
            bindings
        );
        if (current.version !== input.version)
            throw new MiraFailure(
                "CONFLICT",
                "The coding permission changed. Refresh before saving."
            );
        if (input.enabled && !current.available)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Enable qualified Daytona and GitHub integrations before allowing automatic code changes."
            );
        await query`INSERT INTO mira_improvement_grants(automation_id,owner,enabled,version,automation_version,binding_hash,approved_by) VALUES (${input.automationId},${context.owner},${input.enabled},1,${input.automationVersion},${improvementBinding(context.owner, bindings)},${context.actor}) ON CONFLICT(automation_id) DO UPDATE SET enabled=EXCLUDED.enabled,version=mira_improvement_grants.version+1,automation_version=EXCLUDED.automation_version,binding_hash=EXCLUDED.binding_hash,approved_by=EXCLUDED.approved_by,updated_at=clock_timestamp()`;
        await auditMira(
            query,
            context,
            input.enabled ? "improvement.allowed" : "improvement.revoked",
            input.automationId
        );
        return readImprovementGrant(
            { ...context, transaction: query },
            input.automationId,
            bindings
        );
    });
}
/**
 * Fence an automatic workflow against the exact grant, definition, controls and originating run.
 * @param query - Short database transaction or read; callers acquire owner controls before mutations.
 * @param id - Service-generated improvement/job/publication identity.
 * @param kind - Optional downstream payload fence; only the captured automatic job/proposal is authorized.
 * @returns Whether the durable workflow still holds its original authority. Ordinary jobs are unaffected.
 */
export async function improvementJobAllowed(
    query: MiraQuery,
    id: string,
    kind?: "cloud" | "publication"
): Promise<boolean> {
    const [row] = await query<
        { allowed: boolean }[]
    >`SELECT (i.state IN ('queued','checking','publishing') AND i.policy_version=${miraImprovementPolicy.version} AND i.created_at>clock_timestamp()-interval '1 hour' AND g.enabled AND g.version=i.grant_version AND g.binding_hash=i.binding_hash AND a.kind='improvement' AND a.version=g.automation_version AND a.deleted_at IS NULL AND s.enabled AND s.version=i.automation_control AND coalesce(u.enabled,true) AND coalesce(u.version,1)=i.autonomy_control AND NOT r.cancel_requested AND r.state IN ('running','completed','failed','interrupted','needs_attention') AND c.deleted_at IS NULL AND EXISTS(SELECT 1 FROM mira_switches d WHERE d.owner=i.owner AND d.key='integration:daytona' AND d.enabled AND d.version=i.daytona_control) AND EXISTS(SELECT 1 FROM mira_switches h WHERE h.owner=i.owner AND h.key='integration:github' AND h.enabled AND h.version=i.github_control) AND (${kind ?? null}::text IS NULL OR (${kind ?? null}='cloud' AND EXISTS(SELECT 1 FROM mira_daytona_jobs j WHERE j.id=i.id AND j.owner=i.owner AND j.content_hash=i.cloud_hash)) OR (${kind ?? null}='publication' AND EXISTS(SELECT 1 FROM mira_code_publications p WHERE p.id=i.id AND p.owner=i.owner AND p.content_hash=i.publication_hash)))) AS allowed FROM mira_improvements i JOIN mira_improvement_grants g ON g.automation_id=i.automation_id AND g.owner=i.owner JOIN mira_automations a ON a.id=i.automation_id AND a.owner=i.owner JOIN mira_switches s ON s.owner=i.owner AND s.key='automation:'||i.automation_id::text LEFT JOIN mira_switches u ON u.owner=i.owner AND u.key='autonomy' JOIN mira_runs r ON r.id=i.run_id AND r.owner=i.owner JOIN mira_conversations c ON c.id=i.conversation_id AND c.owner=i.owner WHERE i.id=${id}`;
    if (row) return row.allowed === true;
    const [exists] = await query<
        { id: string }[]
    >`SELECT id FROM mira_improvements WHERE id=${id}`;
    return !exists;
}

async function blockedImprovement(query: MiraQuery, owner: string, automationId: string) {
    const [row] = await query<
        { id: string; cloud: boolean; publication: boolean; inspected: boolean }[]
    >`SELECT i.id,coalesce(j.cleanup='pending' OR j.state IN ('queued','running'),false) AS cloud,coalesce(p.state IN ('queued','publishing'),false) AS publication,coalesce((p.id IS NULL OR p.state<>'needs_attention' OR p.observed_at>clock_timestamp()-interval '15 minutes'),false) AS inspected FROM mira_improvements i LEFT JOIN mira_daytona_jobs j ON j.id=i.id AND j.owner=i.owner LEFT JOIN mira_code_publications p ON p.id=i.id AND p.owner=i.owner WHERE i.owner=${owner} AND i.automation_id=${automationId} AND i.state='needs_attention' ORDER BY i.id LIMIT 1`;
    if (!row) return null;
    let reason =
        "Review the existing attempt in Jobs before closing this block. No provider write will be retried.";
    if (row.cloud)
        reason = "Sandbox cleanup must be confirmed or resolved in Cloud jobs first.";
    else if (row.publication)
        reason = "Publication is still running. Wait for its recorded outcome.";
    else if (!row.inspected)
        reason =
            "Use Inspect GitHub on the existing code proposal first; the observation must be less than 15 minutes old.";
    return {
        id: row.id,
        canClose: !row.cloud && !row.publication && row.inspected,
        reason,
    };
}
/**
 * Release a blocked automatic workflow only after explicit operator review and safe downstream settlement.
 * @param context - Signed-in human; no model can acknowledge an uncertain outcome.
 * @param input - Exact blocked attempt, explicit reviewed flag and operator evidence.
 * @returns Completion after the block is closed; external records remain unchanged and writes are never retried.
 */
export async function resolveImprovement(
    context: MiraContext,
    input: v.InferOutput<typeof miraImprovementResolveSchema>
): Promise<void> {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Only the operator can close a reviewed attempt."
        );
    await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const [row] = await query<
            { automationId: string }[]
        >`SELECT automation_id AS "automationId" FROM mira_improvements WHERE id=${input.id} AND owner=${context.owner} AND state='needs_attention' FOR UPDATE`;
        if (!row) throw new MiraFailure("CONFLICT", "This attempt is no longer blocked.");
        const blocked = await blockedImprovement(query, context.owner, row.automationId);
        if (!blocked?.canClose || blocked.id !== input.id)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                blocked?.reason ?? "Inspect the existing attempt first."
            );
        await query`UPDATE mira_improvements SET state='cancelled',message=${`Closed after operator review: ${input.reason}`},updated_at=clock_timestamp() WHERE id=${input.id}`;
        await auditMira(query, context, "improvement.reviewed", input.id);
    });
}
