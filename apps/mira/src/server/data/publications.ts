import {
    miraPublicationContentSchema,
    miraPublicationInputSchema,
    type MiraPublication,
    type MiraPublicationContent,
    type MiraPublicationSave,
    type MiraPublicationApprove,
} from "@homelab/contracts/miraPublication";
import * as v from "valibot";

import {
    hereNowBindingHash,
    type HereNowBinding,
} from "../integrations/herenow/configuration";
import {
    auditMira,
    MiraFailure,
    miraTransaction,
    requireConversation,
    type MiraContext,
    type MiraQuery,
} from "./context";
import { hereNowBindingCurrent } from "./herenow";
import { capturePublicationFiles, readPublicationFiles } from "./publicationFiles";

/**
 * Fingerprint the exact normalized destination, visibility and file snapshots shown for approval.
 * @param content - Server-captured publication content.
 * @returns Stable SHA-256 identity independent of database object-key ordering.
 */
export function miraPublicationHash(content: MiraPublicationContent): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(v.parse(miraPublicationContentSchema, content)))
        .digest("hex");
}

function bindingFor(context: MiraContext, binding?: HereNowBinding): HereNowBinding {
    if (!binding || binding.owner !== context.owner)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "here.now is not configured for this account."
        );
    return binding;
}

async function readDraft(
    query: MiraQuery,
    owner: string,
    id: string
): Promise<MiraPublication> {
    const [row] = await query<
        MiraPublication[]
    >`SELECT id,account_id AS "accountId",version,state,content,content_hash AS "contentHash",conversation_id AS "conversationId",phase,slug,provider_version_id AS "providerVersionId",message,created_at::text AS "createdAt",updated_at::text AS "updatedAt" FROM mira_publications WHERE id=${id} AND owner=${owner}`;
    if (!row) throw new MiraFailure("NOT_FOUND", "Publication draft not found.");
    return row;
}

/**
 * Check current consent and both service mappings for publication admission.
 * @param query - Owner-controls-locked transaction.
 * @param binding - Fixed configured account mapping.
 * @returns Current control version, or null while paused, unprovisioned or stale.
 */
export async function publicationPermission(
    query: MiraQuery,
    binding: HereNowBinding
): Promise<number | null> {
    const hash = hereNowBindingHash(binding);
    const [row] = await query<
        { version: number }[]
    >`SELECT version FROM mira_switches WHERE owner=${binding.owner} AND key='integration:here-now' AND enabled AND binding_hash=${hash} AND EXISTS(SELECT 1 FROM mira_runtime_status WHERE id=1 AND heartbeat_at>clock_timestamp()-interval '45 seconds' AND integrations @> ${JSON.stringify([{ owner: binding.owner, key: "here-now", bindingHash: hash, sendConfigured: true }])}::text::jsonb)`;
    return row && (await hereNowBindingCurrent(query, binding)) ? row.version : null;
}

/**
 * Save a local draft, capturing only owned files without contacting here.now.
 * @param context - Human owner or fenced assistant transaction.
 * @param input - Stable draft identity, expected version and proposed file selections.
 * @param binding - Dashboard or executor account mapping; rebinding cannot move an existing draft.
 * @returns Saved content for explicit review; saving never grants publication permission.
 */
export async function saveMiraPublication(
    context: MiraContext,
    input: MiraPublicationSave,
    binding?: HereNowBinding
): Promise<MiraPublication> {
    const configured = bindingFor(context, binding);
    const proposed = v.parse(miraPublicationInputSchema, input.content);
    const hash = hereNowBindingHash(configured);
    return miraTransaction(context, async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:publication:${input.id}`},0))`;
        if (context.run) {
            const [control] = await query<
                { enabled: boolean }[]
            >`SELECT enabled FROM mira_switches WHERE owner=${context.owner} AND key='integration:here-now' AND binding_hash=${hash}`;
            if (!control?.enabled || !(await hereNowBindingCurrent(query, configured)))
                throw new MiraFailure(
                    "FORBIDDEN",
                    "here.now is paused or its account mapping changed."
                );
        }
        const [existing] = await query<
            {
                owner: string;
                version: number;
                state: string;
                content: MiraPublicationContent;
                binding: string;
                conversationId: string | null;
            }[]
        >`SELECT owner,version,state,content,binding_hash AS binding,conversation_id AS "conversationId" FROM mira_publications WHERE id=${input.id} FOR UPDATE`;
        if (existing) {
            if (existing.owner !== context.owner)
                throw new MiraFailure("NOT_FOUND", "Publication draft not found.");
            const original = v.parse(miraPublicationInputSchema, {
                ...existing.content,
                files: existing.content.files.map(({ id, path }) => ({ id, path })),
            });
            if (
                input.version === 0 &&
                JSON.stringify(original) === JSON.stringify(proposed) &&
                existing.binding === hash &&
                existing.conversationId === input.conversationId
            )
                return readDraft(query, context.owner, input.id);
            if (
                existing.version !== input.version ||
                existing.state !== "draft" ||
                existing.binding !== hash
            )
                throw new MiraFailure(
                    "CONFLICT",
                    "This draft changed or already entered publication. Refresh before editing."
                );
        } else if (input.version !== 0)
            throw new MiraFailure("NOT_FOUND", "Publication draft not found.");
        if (!existing || existing.conversationId !== input.conversationId)
            await requireConversation(query, context.owner, input.conversationId);
        const files = await capturePublicationFiles(
            query,
            context,
            proposed.files,
            input.conversationId
        );
        const content = v.parse(miraPublicationContentSchema, { ...proposed, files });
        const contentHash = miraPublicationHash(content);
        await (existing
            ? query`UPDATE mira_publications SET content=${JSON.stringify(content)}::text::jsonb,content_hash=${contentHash},conversation_id=${input.conversationId},message=NULL,version=version+1,updated_at=now() WHERE id=${input.id}`
            : query`INSERT INTO mira_publications(id,owner,conversation_id,account_id,binding_hash,content,content_hash) VALUES (${input.id},${context.owner},${input.conversationId},${configured.accountId},${hash},${JSON.stringify(content)}::text::jsonb,${contentHash})`);
        await auditMira(query, context, "publication.draft_saved", input.id);
        return readDraft(query, context.owner, input.id);
    });
}

/**
 * Read a bounded page of owned publication drafts and durable results.
 * @param context - Verified product owner.
 * @param filter - Optional owned conversation and descending pagination cursor.
 * @returns Local records; no provider reads or implicit publication.
 */
export async function listMiraPublications(
    context: MiraContext,
    filter: { before?: string | undefined; conversationId?: string | undefined }
) {
    const rows = await context.client<
        MiraPublication[]
    >`SELECT id,account_id AS "accountId",version,state,content,content_hash AS "contentHash",conversation_id AS "conversationId",phase,slug,provider_version_id AS "providerVersionId",message,created_at::text AS "createdAt",updated_at::text AS "updatedAt" FROM mira_publications WHERE owner=${context.owner} AND (${filter.before ?? null}::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM mira_publications WHERE id=${filter.before ?? null}::uuid AND owner=${context.owner})) AND (${filter.conversationId ?? null}::uuid IS NULL OR conversation_id=${filter.conversationId ?? null}::uuid) ORDER BY created_at DESC,id DESC LIMIT 20`;
    return { rows, nextCursor: rows.length === 20 ? rows.at(-1)!.id : null };
}

/**
 * Queue only an exact human-reviewed public publication after verifying its files.
 * @param context - Signed-in human; model contexts cannot approve their own work.
 * @param input - Displayed version, content hash and full review snapshot.
 * @param binding - Dashboard account mapping, matched with a fresh publishing executor.
 * @param directory - Shared private file store used to verify every reviewed byte.
 * @returns Durable queued state; replaying the same approval cannot duplicate publication.
 */
export async function approveMiraPublication(
    context: MiraContext,
    input: MiraPublicationApprove,
    binding?: HereNowBinding,
    directory?: string
): Promise<MiraPublication> {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Publishing requires the operator's confirmation."
        );
    const configured = bindingFor(context, binding);
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const [row] = await query<
            {
                version: number;
                state: string;
                hash: string;
                binding: string;
                approvedVersion: number | null;
                content: MiraPublicationContent;
            }[]
        >`SELECT version,state,content,content_hash AS hash,binding_hash AS binding,approved_version AS "approvedVersion" FROM mira_publications WHERE id=${input.id} AND owner=${context.owner} FOR UPDATE`;
        if (!row) throw new MiraFailure("NOT_FOUND", "Publication draft not found.");
        if (
            row.hash !== input.contentHash ||
            miraPublicationHash(row.content) !== row.hash ||
            miraPublicationHash(input.reviewedContent) !== row.hash
        )
            throw new MiraFailure(
                "CONFLICT",
                "The publication changed. Review its current files, destination and visibility."
            );
        if (row.approvedVersion === input.version)
            return readDraft(query, context.owner, input.id);
        if (
            row.state !== "draft" ||
            row.version !== input.version ||
            row.binding !== hereNowBindingHash(configured)
        )
            throw new MiraFailure(
                "CONFLICT",
                "This draft changed or belongs to a previous here.now account. Refresh before publishing."
            );
        await readPublicationFiles(
            { ...context, transaction: query },
            directory,
            row.content.files
        );
        const control = await publicationPermission(query, configured);
        if (control === null)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "here.now must be enabled and connected with a publishing credential before publication."
            );
        await query`UPDATE mira_publications SET state='queued',message=NULL,retry_after=NULL,approved_version=version,approved_by=${context.actor},approved_at=clock_timestamp(),control_version=${control},version=version+1,updated_at=now() WHERE id=${input.id}`;
        await auditMira(query, context, "publication.approved", input.id);
        return readDraft(query, context.owner, input.id);
    });
}

/**
 * Cancel a draft or queued publication before external work begins.
 * @param context - Signed-in human owner.
 * @param input - Reviewed draft identity and current version.
 * @returns Completion after cancellation; an in-flight attempt must be inspected separately.
 */
export async function cancelMiraPublication(
    context: MiraContext,
    input: { id: string; version: number }
): Promise<void> {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure("FORBIDDEN", "Only the operator can cancel publication.");
    await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_publications SET state='cancelled',message='Cancelled before publication.',version=version+1,updated_at=now() WHERE id=${input.id} AND owner=${context.owner} AND version=${input.version} AND state IN ('draft','queued') RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "This draft changed or publication already started. Refresh to see its outcome."
            );
        await auditMira(query, context, "publication.cancelled", input.id);
    });
}
