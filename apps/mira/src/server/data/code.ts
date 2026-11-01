import {
    miraCodeContentSchema,
    miraCodeInputSchema,
    type MiraCodeContent,
    type MiraCodePublication,
    type MiraCodeSave,
    type MiraCodeApprove,
} from "@homelab/contracts/miraCode";
import * as v from "valibot";

import {
    githubBindingHash,
    type GitHubBinding,
} from "../integrations/github/configuration";
import { requireMiraApproval } from "./approvalPolicy";
import { captureCodeSource, readCodeSource } from "./codeSource";
import {
    auditMira,
    MiraFailure,
    miraTransaction,
    type MiraContext,
    type MiraQuery,
} from "./context";
import { githubBindingCurrent } from "./github";

/**
 * Hash the exact captured metadata and tested source shown in review.
 * @param content - Server-captured source and proposed PR text.
 * @returns Stable SHA-256 independent of database JSON key ordering.
 */
export function miraCodeHash(content: MiraCodeContent): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(v.parse(miraCodeContentSchema, content)))
        .digest("hex");
}
function human(context: MiraContext) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Code publication requires the operator's confirmation."
        );
}
function bindingFor(context: MiraContext, binding?: GitHubBinding): GitHubBinding {
    if (!binding || binding.owner !== context.owner)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "GitHub publication is not configured for this account."
        );
    return binding;
}
/**
 * Verify the enabled operator control and both fresh service mappings.
 * @param query - Owner-controls-locked transaction.
 * @param binding - Fixed operator and repository mapping.
 * @returns Consent version, or null while unavailable, stale, paused or rebound.
 */
export async function codePermission(
    query: MiraQuery,
    binding: GitHubBinding
): Promise<number | null> {
    const hash = githubBindingHash(binding);
    const [row] = await query<
        { version: number }[]
    >`SELECT version FROM mira_switches WHERE owner=${binding.owner} AND key='integration:github' AND enabled AND binding_hash=${hash} AND EXISTS(SELECT 1 FROM mira_runtime_status WHERE id=1 AND heartbeat_at>clock_timestamp()-interval '45 seconds' AND integrations @> ${JSON.stringify([{ owner: binding.owner, key: "github", bindingHash: hash, sendConfigured: true }])}::text::jsonb)`;
    return row && (await githubBindingCurrent(query, binding)) ? row.version : null;
}
/**
 * Read one owned local publication without contacting GitHub.
 * @param query - Database connection or admission transaction.
 * @param owner - Verified product owner.
 * @param id - Publication UUID.
 * @returns Durable status and public references, never credentials.
 */
export async function readMiraCode(
    query: MiraQuery,
    owner: string,
    id: string
): Promise<MiraCodePublication> {
    const [row] = await query<
        MiraCodePublication[]
    >`SELECT id,version,conversation_id AS "conversationId",state,content,content_hash AS "contentHash",phase,branch,commit,number,observation,inspection_requested AS "inspectionRequested",observed_at::text AS "observedAt",message,created_at::text AS "createdAt",updated_at::text AS "updatedAt" FROM mira_code_publications WHERE id=${id} AND owner=${owner}`;
    if (!row) throw new MiraFailure("NOT_FOUND", "Code proposal not found.");
    return row;
}
/**
 * Save a local source-bound proposal without granting publication authority.
 * @param context - Human or fenced assistant context.
 * @param input - Stable UUID, expected version and owned successful check.
 * @param binding - Explicit dashboard/executor operator mapping.
 * @returns Saved draft; identical initial retries preserve one record.
 */
export async function saveMiraCode(
    context: MiraContext,
    input: MiraCodeSave,
    binding?: GitHubBinding
): Promise<MiraCodePublication> {
    const configured = bindingFor(context, binding),
        proposed = v.parse(miraCodeInputSchema, input.content),
        hash = githubBindingHash(configured);
    return miraTransaction(context, async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:code:${input.id}`},0))`;
        if (context.run && (await codePermission(query, configured)) === null)
            throw new MiraFailure(
                "FORBIDDEN",
                "GitHub publication is paused or unavailable."
            );
        const [existing] = await query<
            {
                owner: string;
                version: number;
                state: string;
                content: MiraCodeContent;
                binding: string;
                conversationId: string | null;
            }[]
        >`SELECT owner,version,state,content,binding_hash AS binding,conversation_id AS "conversationId" FROM mira_code_publications WHERE id=${input.id} FOR UPDATE`;
        if (existing) {
            if (
                existing.owner !== context.owner ||
                (context.run && existing.conversationId !== input.conversationId)
            )
                throw new MiraFailure("NOT_FOUND", "Code proposal not found.");
            const { edits: _edits, ...original } = v.parse(
                miraCodeContentSchema,
                existing.content
            );
            if (
                input.version === 0 &&
                JSON.stringify(original) === JSON.stringify(proposed) &&
                existing.binding === hash &&
                existing.conversationId === input.conversationId
            )
                return readMiraCode(query, context.owner, input.id);
            if (
                existing.version !== input.version ||
                existing.state !== "draft" ||
                existing.binding !== hash
            )
                throw new MiraFailure(
                    "CONFLICT",
                    "This proposal changed or already entered publication. Refresh before editing."
                );
        } else if (input.version !== 0)
            throw new MiraFailure("NOT_FOUND", "Code proposal not found.");
        const content = await captureCodeSource(
                query,
                context,
                proposed,
                input.conversationId
            ),
            contentHash = miraCodeHash(content);
        await (existing
            ? query`UPDATE mira_code_publications SET content=${JSON.stringify(content)}::text::jsonb,content_hash=${contentHash},check_id=${content.checkId},conversation_id=${input.conversationId},message=NULL,version=version+1,updated_at=now() WHERE id=${input.id}`
            : query`INSERT INTO mira_code_publications(id,owner,conversation_id,check_id,binding_hash,content,content_hash) VALUES (${input.id},${context.owner},${input.conversationId},${content.checkId},${hash},${JSON.stringify(content)}::text::jsonb,${contentHash})`);
        await auditMira(query, context, "code.draft_saved", input.id);
        return readMiraCode(query, context.owner, input.id);
    });
}
/**
 * List a bounded page of owned code proposals and outcomes.
 * @param context - Verified owner.
 * @param filter - Optional conversation and descending cursor.
 * @returns Local records with pagination; no provider calls.
 */
export async function listMiraCode(
    context: MiraContext,
    filter: { before?: string | undefined; conversationId?: string | undefined }
) {
    const rows = await context.client<
        { id: string }[]
    >`SELECT id FROM mira_code_publications WHERE owner=${context.owner} AND (${filter.before ?? null}::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM mira_code_publications WHERE id=${filter.before ?? null}::uuid AND owner=${context.owner})) AND (${filter.conversationId ?? null}::uuid IS NULL OR conversation_id=${filter.conversationId ?? null}::uuid) ORDER BY created_at DESC,id DESC LIMIT 20`;
    const records = await Promise.all(
        rows.map((row) => readMiraCode(context.client, context.owner, row.id))
    );
    return { rows: records, nextCursor: rows.length === 20 ? rows.at(-1)!.id : null };
}
/**
 * Queue one exact human-reviewed, successful edit check for draft PR publication.
 * @param context - Signed-in operator, never a model context.
 * @param input - Displayed version, content fingerprint and full review snapshot.
 * @param binding - Explicit operator mapping matched to the publishing executor.
 * @param directory - Private file volume for byte verification.
 * @returns Queued record; repeat approval cannot duplicate a publication.
 */
export async function approveMiraCode(
    context: MiraContext,
    input: MiraCodeApprove,
    binding?: GitHubBinding,
    directory?: string
): Promise<MiraCodePublication> {
    const configured = bindingFor(context, binding);
    return miraTransaction(context, async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const [locked] = await query<
            { binding: string; approvedVersion: number | null }[]
        >`SELECT binding_hash AS binding,approved_version AS "approvedVersion" FROM mira_code_publications WHERE id=${input.id} AND owner=${context.owner} FOR UPDATE`;
        const row = await readMiraCode(query, context.owner, input.id);
        const approvalRunId = await requireMiraApproval(
            query,
            context,
            row.conversationId,
            "external"
        );
        if (
            row.contentHash !== input.contentHash ||
            miraCodeHash(row.content) !== row.contentHash ||
            miraCodeHash(input.reviewedContent) !== row.contentHash
        )
            throw new MiraFailure(
                "CONFLICT",
                "The code proposal changed. Review its current source and PR text."
            );
        if (locked!.approvedVersion === input.version) return row;
        if (
            row.state !== "draft" ||
            row.version !== input.version ||
            locked!.binding !== githubBindingHash(configured)
        )
            throw new MiraFailure(
                "CONFLICT",
                "This proposal changed or belongs to a previous GitHub binding."
            );
        await readCodeSource(
            { ...context, transaction: query },
            row.content,
            row.conversationId,
            directory
        );
        const permission = await codePermission(query, configured);
        if (permission === null)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "GitHub must be enabled and connected before publication."
            );
        const [used] = await query<
            { id: string }[]
        >`SELECT id FROM mira_code_publications WHERE check_id=${row.content.checkId} AND state NOT IN ('draft','cancelled') LIMIT 1`;
        if (used)
            throw new MiraFailure(
                "CONFLICT",
                "This check already has a queued or attempted publication. Inspect that proposal."
            );
        await query`UPDATE mira_code_publications SET state='queued',approval_run_id=${approvalRunId},message=NULL,approved_version=version,approved_by=${context.actor},approved_at=clock_timestamp(),control_version=${permission},version=version+1,updated_at=now() WHERE id=${input.id}`;
        await auditMira(query, context, "code.approved", input.id);
        return readMiraCode(query, context.owner, input.id);
    });
}
/**
 * Cancel a local proposal before external publication starts.
 * @param context - Signed-in operator.
 * @param input - Current version and owned publication identity.
 * @returns Completion after cancellation; started attempts require read-only inspection.
 */
export async function cancelMiraCode(
    context: MiraContext,
    input: { id: string; version: number }
): Promise<void> {
    human(context);
    await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_code_publications SET state='cancelled',message='Cancelled before publication.',version=version+1,updated_at=now() WHERE id=${input.id} AND owner=${context.owner} AND version=${input.version} AND state IN ('draft','queued') RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "This proposal changed or publication already started."
            );
        await auditMira(query, context, "code.cancelled", input.id);
    });
}
/**
 * Request a bounded read-only provider reconciliation without granting another write.
 * @param context - Signed-in operator.
 * @param input - Current owned attempted publication.
 * @returns Completion after a durable inspection request; dispatch never republishes it.
 */
export async function inspectMiraCode(
    context: MiraContext,
    input: { id: string; version: number }
): Promise<void> {
    human(context);
    await context.client.begin(async (query) => {
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_code_publications SET inspection_requested=true,version=version+1,updated_at=now() WHERE id=${input.id} AND owner=${context.owner} AND version=${input.version} AND state IN ('published','needs_attention') AND NOT inspection_requested RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "This proposal changed or inspection is already pending."
            );
        await auditMira(query, context, "code.inspection_requested", input.id);
    });
}
