import {
    miraDaytonaContentSchema,
    type MiraDaytonaApprove,
    type MiraDaytonaContent,
    type MiraDaytonaJob,
    type MiraDaytonaSave,
} from "@homelab/contracts/miraDaytona";
import * as v from "valibot";

import {
    daytonaBindingHash,
    type DaytonaBinding,
} from "../integrations/daytona/configuration";
import {
    isLocalCodeBinding,
    localCodeBindingHash,
    localCodeBindingSchema,
    localCodePermission,
    type CodeJobBinding,
} from "../sandbox/localBinding";
import { localCodeRequest } from "../sandbox/localProtocol";
import {
    auditMira,
    MiraFailure,
    miraTransaction,
    requireConversation,
    requireTask,
    type MiraContext,
    type MiraQuery,
} from "./context";

/**
 * Fingerprint exact reviewed command and selected transfers.
 * @param content - Validated proposal.
 * @returns Stable digest.
 */
export function miraDaytonaHash(content: MiraDaytonaContent): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(v.parse(miraDaytonaContentSchema, content)))
        .digest("hex");
}
/**
 * Publish or revoke the dashboard's nonsecret Daytona mapping.
 * @param query - Product database.
 * @param binding - Configured mapping.
 * @returns Committed heartbeat.
 */
export async function publishDaytonaBinding(
    query: MiraQuery,
    binding?: DaytonaBinding
): Promise<void> {
    await query`INSERT INTO mira_integration_receivers(key,binding_hash,heartbeat_at) VALUES('daytona',${binding ? daytonaBindingHash(binding) : null},now()) ON CONFLICT(key) DO UPDATE SET binding_hash=EXCLUDED.binding_hash,heartbeat_at=EXCLUDED.heartbeat_at`;
}
/**
 * Describe qualified executor agreement independently of pause.
 * @param context - Verified owner.
 * @param binding - Dashboard mapping.
 * @returns Shared integration status.
 */
export async function daytonaIntegrationStatus(
    context: MiraContext,
    binding?: DaytonaBinding
) {
    const base = {
        key: "integration:daytona",
        title: "Daytona",
        description:
            "Run reviewed cloud jobs and retrieve selected results. Pausing stops work while cleanup continues.",
        configured: false,
        ready: false,
        message: null as string | null,
        lastSuccessAt: null as string | null,
    };
    if (!binding || binding.owner !== context.owner) return base;
    const hash = daytonaBindingHash(binding);
    const [row] = await context.client<
        { matched: boolean; fresh: boolean; granted: boolean }[]
    >`SELECT integrations @> ${JSON.stringify([{ owner: context.owner, key: "daytona", bindingHash: hash, sendConfigured: true }])}::text::jsonb AS matched,heartbeat_at>clock_timestamp()-interval '45 seconds' AS fresh,NOT EXISTS(SELECT 1 FROM mira_switches WHERE owner=${context.owner} AND key='integration:daytona' AND enabled AND binding_hash IS DISTINCT FROM ${hash}) AS granted FROM mira_runtime_status WHERE id=1`;
    let message: string | null = null;
    if (!row?.matched)
        message =
            "Daytona requires matching configuration and a qualified private snapshot before it can run jobs.";
    else if (!row.granted)
        message = "Pause and enable Daytona to confirm the changed account or snapshot.";
    return {
        ...base,
        configured: row?.matched === true,
        ready: row?.matched === true && row.fresh && row.granted,
        message,
    };
}
/**
 * Check current controls and both services before cloud execution.
 * @param query - Owner-controls-locked transaction or read.
 * @param binding - Fixed mapping.
 * @returns Consent version or null.
 */
export async function daytonaPermission(
    query: MiraQuery,
    binding: DaytonaBinding
): Promise<number | null> {
    const hash = daytonaBindingHash(binding);
    const [row] = await query<
        { version: number }[]
    >`SELECT s.version FROM mira_switches s WHERE owner=${binding.owner} AND key='integration:daytona' AND enabled AND binding_hash=${hash} AND EXISTS(SELECT 1 FROM mira_runtime_status WHERE id=1 AND heartbeat_at>clock_timestamp()-interval '45 seconds' AND integrations @> ${JSON.stringify([{ owner: binding.owner, key: "daytona", bindingHash: hash, sendConfigured: true }])}::text::jsonb) AND EXISTS(SELECT 1 FROM mira_integration_receivers WHERE key='daytona' AND binding_hash=${hash} AND heartbeat_at>clock_timestamp()-interval '45 seconds')`;
    return row?.version ?? null;
}
/**
 * Read one owned job without credentials, leases or provider payloads.
 * @param query - Product connection.
 * @param owner - Verified owner.
 * @param id - Job ID.
 * @returns Public job.
 */
export async function readMiraDaytona(
    query: MiraQuery,
    owner: string,
    id: string
): Promise<MiraDaytonaJob> {
    const [row] = await query<
        MiraDaytonaJob[]
    >`SELECT id,execution_target AS "executionTarget",version,content,content_hash AS "contentHash",conversation_id AS "conversationId",task_id AS "taskId",state,phase,cleanup,cancel_requested AS "cancelRequested",exit_code AS "exitCode",stdout,stderr,output,files,message,created_at::text AS "createdAt",updated_at::text AS "updatedAt" FROM mira_daytona_jobs WHERE id=${id} AND owner=${owner}`;
    if (!row) throw new MiraFailure("NOT_FOUND", "Daytona job not found.");
    return row;
}
/**
 * Validate the exact owned input files before approval and dispatch.
 * @param query - Product transaction.
 * @param owner - Verified owner.
 * @param content - Reviewed transfer list.
 * @returns Completion or fail-closed missing-file error.
 */
export async function validateDaytonaInputs(
    query: MiraQuery,
    owner: string,
    content: MiraDaytonaContent
): Promise<void> {
    for (const file of content.inputs) {
        const [row] = await query<
            { id: string }[]
        >`SELECT id FROM mira_attachments WHERE id=${file.id} AND owner=${owner} AND sha256=${file.sha256} AND ready_at IS NOT NULL AND deleted_at IS NULL AND bytes BETWEEN 1 AND 1048576 FOR SHARE`;
        if (!row)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "A selected input changed, was deleted or exceeds 1 MiB. Review the files again."
            );
    }
}
function configured(context: MiraContext, binding?: CodeJobBinding): CodeJobBinding {
    if (!binding || binding.owner !== context.owner)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "The code execution target is not configured for this account."
        );
    return binding;
}
function bindingHash(binding: CodeJobBinding): string {
    return isLocalCodeBinding(binding)
        ? localCodeBindingHash(binding)
        : daytonaBindingHash(binding);
}
/**
 * Check the exact selected execution target without falling back to another provider.
 * @param query - Owner-controls-locked transaction or read.
 * @param binding - Reviewed Main or Daytona mapping.
 * @returns Current consent version, or null when unavailable or paused.
 */
export function codeJobPermission(
    query: MiraQuery,
    binding: CodeJobBinding
): Promise<number | null> {
    return isLocalCodeBinding(binding)
        ? localCodePermission(query, binding)
        : daytonaPermission(query, binding);
}
function human(context: MiraContext): void {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Only the operator can approve or cancel cloud jobs."
        );
}
/**
 * Save a proposal without allocating resources or running code.
 * @param context - Human or fenced model owner.
 * @param input - Exact draft and optional links.
 * @param binding - Configured account.
 * @returns Persisted proposal.
 */
export async function saveMiraDaytona(
    context: MiraContext,
    input: MiraDaytonaSave,
    binding?: CodeJobBinding
): Promise<MiraDaytonaJob> {
    const account = configured(context, binding),
        content = v.parse(miraDaytonaContentSchema, input.content),
        hash = miraDaytonaHash(content),
        targetHash = bindingHash(account);
    const local = isLocalCodeBinding(account);
    if (input.executionTarget && input.executionTarget !== (local ? "main" : "daytona"))
        throw new MiraFailure(
            "CONFLICT",
            "The selected code target is unavailable. No fallback was used."
        );
    if (local) localCodeRequest(input.id, content);
    return miraTransaction(context, async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:daytona:${input.id}`},0))`;
        const [row] = await query<
            {
                owner: string;
                version: number;
                state: string;
                hash: string;
                binding: string;
                conversationId: string | null;
                taskId: string | null;
            }[]
        >`SELECT owner,version,state,content_hash AS hash,binding_hash AS binding,conversation_id AS "conversationId",task_id AS "taskId" FROM mira_daytona_jobs WHERE id=${input.id} FOR UPDATE`;
        if (row?.owner !== undefined && row.owner !== context.owner)
            throw new MiraFailure("NOT_FOUND", "Daytona job not found.");
        if (
            row &&
            input.version === 0 &&
            row.hash === hash &&
            row.binding === targetHash &&
            row.conversationId === input.conversationId &&
            row.taskId === input.taskId
        )
            return readMiraDaytona(query, context.owner, input.id);
        if (
            row
                ? row.version !== input.version ||
                  row.state !== "draft" ||
                  row.binding !== targetHash
                : input.version !== 0
        )
            throw new MiraFailure("CONFLICT", "The job changed. Refresh before editing.");
        if (context.run && (await codeJobPermission(query, account)) === null)
            throw new MiraFailure(
                "FORBIDDEN",
                "Code execution is paused or unavailable."
            );
        await requireConversation(query, context.owner, input.conversationId);
        await requireTask(query, context.owner, input.taskId);
        await validateDaytonaInputs(query, context.owner, content);
        await (row
            ? query`UPDATE mira_daytona_jobs SET content=${JSON.stringify(content)}::text::jsonb,content_hash=${hash},conversation_id=${input.conversationId},task_id=${input.taskId},version=version+1,updated_at=now(),message=NULL WHERE id=${input.id}`
            : query`INSERT INTO mira_daytona_jobs(id,owner,binding,binding_hash,content,content_hash,conversation_id,task_id,execution_target) VALUES(${input.id},${context.owner},${JSON.stringify(isLocalCodeBinding(account) ? v.parse(localCodeBindingSchema, account) : { owner: account.owner, organizationId: account.organizationId, snapshotId: account.snapshotId, target: account.target, trustBoundary: account.trustBoundary, networkAccess: account.networkAccess })}::text::jsonb,${targetHash},${JSON.stringify(content)}::text::jsonb,${hash},${input.conversationId},${input.taskId},${local ? "main" : "daytona"})`);
        await auditMira(query, context, "daytona.draft_saved", input.id);
        return readMiraDaytona(query, context.owner, input.id);
    });
}
/**
 * Queue an exact human-reviewed command with a fifteen-minute approval.
 * @param context - Signed-in human.
 * @param input - Displayed content and version.
 * @param binding - Configured mapping.
 * @returns Queued job, never a provider call.
 */
export async function approveMiraDaytona(
    context: MiraContext,
    input: MiraDaytonaApprove,
    binding?: CodeJobBinding
): Promise<MiraDaytonaJob> {
    human(context);
    const account = configured(context, binding);
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const [row] = await query<
            { binding: string }[]
        >`SELECT binding_hash AS binding FROM mira_daytona_jobs WHERE id=${input.id} AND owner=${context.owner} FOR UPDATE`;
        const job = await readMiraDaytona(query, context.owner, input.id);
        const stamp = await codeJobPermission(query, account);
        if (stamp === null)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Code execution is paused, unavailable or not qualified."
            );
        if (
            job.state !== "draft" ||
            job.executionTarget !== (isLocalCodeBinding(account) ? "main" : "daytona") ||
            job.executionTarget !== (input.executionTarget ?? "daytona") ||
            job.version !== input.version ||
            job.contentHash !== input.contentHash ||
            miraDaytonaHash(input.reviewedContent) !== job.contentHash ||
            row?.binding !== bindingHash(account)
        )
            throw new MiraFailure(
                "CONFLICT",
                "The reviewed job changed. Refresh and review again."
            );
        await requireConversation(query, context.owner, job.conversationId);
        if (isLocalCodeBinding(account)) localCodeRequest(job.id, job.content);
        await requireTask(query, context.owner, job.taskId);
        await validateDaytonaInputs(query, context.owner, job.content);
        await query`UPDATE mira_daytona_jobs SET state='queued',approved_at=clock_timestamp(),control_version=${stamp},version=version+1,updated_at=now(),message=NULL WHERE id=${input.id}`;
        await auditMira(query, context, "daytona.approved", input.id);
        return readMiraDaytona(query, context.owner, input.id);
    });
}
/**
 * Request cancellation; active sandboxes remain pending until cleanup is confirmed.
 * @param context - Human owner.
 * @param input - Current job version.
 * @returns Persisted cancellation request.
 */
export async function cancelMiraDaytona(
    context: MiraContext,
    input: { id: string; version: number }
): Promise<MiraDaytonaJob> {
    human(context);
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const [row] = await query<
            { id: string }[]
        >`UPDATE mira_daytona_jobs SET cancel_requested=true,outcome='cancelled',state=CASE WHEN cleanup='not_needed' THEN 'cancelled' ELSE state END,phase=CASE WHEN cleanup='not_needed' THEN 'closed' ELSE phase END,version=version+1,updated_at=now() WHERE id=${input.id} AND owner=${context.owner} AND version=${input.version} AND cleanup IN ('not_needed','pending') AND (state IN ('draft','queued','running','needs_attention')) RETURNING id`;
        if (!row)
            throw new MiraFailure(
                "CONFLICT",
                "The job changed. Refresh before cancelling."
            );
        await auditMira(query, context, "daytona.cancel_requested", input.id);
        return readMiraDaytona(query, context.owner, input.id);
    });
}
/**
 * List bounded owned history without fetching the provider.
 * @param context - Verified owner.
 * @param filter - Optional cursor and conversation.
 * @returns Page and continuation.
 */
export async function listMiraDaytona(
    context: MiraContext,
    filter: { before?: string | undefined; conversationId?: string | undefined }
) {
    const ids = await context.client<
        { id: string }[]
    >`SELECT id FROM mira_daytona_jobs WHERE owner=${context.owner} AND (${filter.before ?? null}::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM mira_daytona_jobs WHERE id=${filter.before ?? null}::uuid AND owner=${context.owner})) AND (${filter.conversationId ?? null}::uuid IS NULL OR conversation_id=${filter.conversationId ?? null}::uuid) ORDER BY created_at DESC,id DESC LIMIT 20`;
    return {
        rows: await Promise.all(
            ids.map((row) => readMiraDaytona(context.client, context.owner, row.id))
        ),
        nextCursor: ids.length === 20 ? ids.at(-1)!.id : null,
    };
}

/**
 * Resolve one owned file for explicit cloud export review.
 * @param context - Signed-in owner.
 * @param id - Selected file identity.
 * @returns Immutable digest and display name, with the 1 MiB limit enforced.
 */
export async function daytonaInputDescriptor(
    context: MiraContext,
    id: string
): Promise<{ id: string; name: string; sha256: string }> {
    const [row] = await context.client<
        { id: string; name: string; sha256: string }[]
    >`SELECT id,name,sha256 FROM mira_attachments WHERE id=${id} AND owner=${context.owner} AND ready_at IS NOT NULL AND deleted_at IS NULL AND bytes BETWEEN 1 AND 1048576`;
    if (!row) throw new MiraFailure("NOT_FOUND", "Choose an available file up to 1 MiB.");
    return row;
}
