import {
    miraSocialContentSchema,
    type MiraSocialContent,
    type MiraSocialDraft,
    type MiraSocialSave,
    type MiraSocialApprove,
    type MiraSocialVerify,
} from "@homelab/contracts/miraSocial";
import * as v from "valibot";

import {
    moltbookBindingHash,
    type MoltbookBinding,
} from "../integrations/moltbook/configuration";
import {
    auditMira,
    MiraFailure,
    miraTransaction,
    requireConversation,
    type MiraContext,
    type MiraQuery,
} from "./context";
import { moltbookBindingCurrent } from "./moltbook";

/**
 * Hash exact reviewed text and destination, preserving whitespace and Unicode.
 * @param content - Validated post or reply snapshot.
 * @returns Stable SHA-256 fingerprint independent of database JSON ordering.
 */
export function miraSocialHash(content: MiraSocialContent): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(v.parse(miraSocialContentSchema, content)))
        .digest("hex");
}
function bindingFor(context: MiraContext, binding?: MoltbookBinding): MoltbookBinding {
    if (!binding || binding.owner !== context.owner)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Moltbook is not configured for this account."
        );
    return binding;
}
function human(context: MiraContext): void {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Moltbook publication requires the operator's confirmation."
        );
}
async function readDraft(
    query: MiraQuery,
    owner: string,
    id: string
): Promise<MiraSocialDraft> {
    const [row] = await query<
        MiraSocialDraft[]
    >`SELECT id,agent_name AS "agentName",version,state,content,content_hash AS "contentHash",conversation_id AS "conversationId",provider_id AS "providerId",challenge,expires_at::text AS "expiresAt",message,created_at::text AS "createdAt",updated_at::text AS "updatedAt" FROM mira_social_drafts WHERE id=${id} AND owner=${owner}`;
    if (!row) throw new MiraFailure("NOT_FOUND", "Moltbook draft not found.");
    return row;
}
/**
 * Require both read and independently enabled publishing controls on the current account.
 * @param query - Owner-controls-locked product transaction.
 * @param binding - Fixed configured agent mapping.
 * @returns Both consent versions, or null before provisioning, while paused or after rebinding.
 */
export async function socialPermission(
    query: MiraQuery,
    binding: MoltbookBinding
): Promise<string | null> {
    const hash = moltbookBindingHash(binding);
    const [row] = await query<
        { stamp: string }[]
    >`SELECT r.version::text || ':' || p.version::text AS stamp FROM mira_switches r JOIN mira_switches p ON p.owner=r.owner AND p.key='integration:moltbook-publish' WHERE r.owner=${binding.owner} AND r.key='integration:moltbook' AND r.enabled AND p.enabled AND r.binding_hash=${hash} AND p.binding_hash=${hash} AND EXISTS(SELECT 1 FROM mira_runtime_status WHERE id=1 AND heartbeat_at>clock_timestamp()-interval '45 seconds' AND integrations @> ${JSON.stringify([{ owner: binding.owner, key: "moltbook-publish", bindingHash: hash, sendConfigured: true }])}::text::jsonb)`;
    return row && (await moltbookBindingCurrent(query, binding)) ? row.stamp : null;
}
/**
 * Save a local proposal without contacting the social service or authorizing a send.
 * @param context - Human owner or fenced assistant transaction.
 * @param input - Stable draft identity, expected version and exact proposed text/target.
 * @param binding - Current configured agent, never selected by draft arguments.
 * @returns Local draft; retrying the same initial proposal returns the same record.
 */
export async function saveMiraSocial(
    context: MiraContext,
    input: MiraSocialSave,
    binding?: MoltbookBinding
): Promise<MiraSocialDraft> {
    const configured = bindingFor(context, binding);
    const content = v.parse(miraSocialContentSchema, input.content);
    const hash = miraSocialHash(content),
        account = moltbookBindingHash(configured);
    return miraTransaction(context, async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:social:${input.id}`},0))`;
        if (context.run && (await socialPermission(query, configured)) === null)
            throw new MiraFailure(
                "FORBIDDEN",
                "Moltbook publishing is paused or unavailable."
            );
        const [existing] = await query<
            {
                owner: string;
                version: number;
                state: string;
                hash: string;
                binding: string;
                conversationId: string | null;
            }[]
        >`SELECT owner,version,state,content_hash AS hash,binding_hash AS binding,conversation_id AS "conversationId" FROM mira_social_drafts WHERE id=${input.id} FOR UPDATE`;
        if (existing) {
            if (existing.owner !== context.owner)
                throw new MiraFailure("NOT_FOUND", "Moltbook draft not found.");
            if (
                input.version === 0 &&
                existing.hash === hash &&
                existing.binding === account &&
                existing.conversationId === input.conversationId
            )
                return readDraft(query, context.owner, input.id);
            if (
                existing.version !== input.version ||
                existing.state !== "draft" ||
                existing.binding !== account
            )
                throw new MiraFailure(
                    "CONFLICT",
                    "This draft changed or entered publication. Refresh before editing."
                );
        } else if (input.version !== 0)
            throw new MiraFailure("NOT_FOUND", "Moltbook draft not found.");
        await requireConversation(query, context.owner, input.conversationId);
        await (existing
            ? query`UPDATE mira_social_drafts SET content=${JSON.stringify(content)}::text::jsonb,content_hash=${hash},conversation_id=${input.conversationId},message=NULL,version=version+1,updated_at=now() WHERE id=${input.id}`
            : query`INSERT INTO mira_social_drafts(id,owner,conversation_id,agent_name,binding_hash,content,content_hash) VALUES(${input.id},${context.owner},${input.conversationId},${configured.agentName},${account},${JSON.stringify(content)}::text::jsonb,${hash})`);
        await auditMira(query, context, "social.draft_saved", input.id);
        return readDraft(query, context.owner, input.id);
    });
}
/**
 * List local owned drafts and submission outcomes without fetching or acknowledging provider activity.
 * @param context - Verified product owner.
 * @param filter - Optional conversation and descending page cursor.
 * @returns At most twenty drafts, excluding private verification codes and answers.
 */
export async function listMiraSocial(
    context: MiraContext,
    filter: { before?: string | undefined; conversationId?: string | undefined }
) {
    const rows = await context.client<
        MiraSocialDraft[]
    >`SELECT id,agent_name AS "agentName",version,state,content,content_hash AS "contentHash",conversation_id AS "conversationId",provider_id AS "providerId",challenge,expires_at::text AS "expiresAt",message,created_at::text AS "createdAt",updated_at::text AS "updatedAt" FROM mira_social_drafts WHERE owner=${context.owner} AND (${filter.before ?? null}::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM mira_social_drafts WHERE id=${filter.before ?? null}::uuid AND owner=${context.owner})) AND (${filter.conversationId ?? null}::uuid IS NULL OR conversation_id=${filter.conversationId ?? null}::uuid) ORDER BY created_at DESC,id DESC LIMIT 20`;
    return { rows, nextCursor: rows.length === 20 ? rows.at(-1)!.id : null };
}
/**
 * Queue only the exact text and destination displayed to the signed-in operator.
 * @param context - Human owner; models cannot approve drafts.
 * @param input - Displayed version, hash and content snapshot.
 * @param binding - Current configured agent.
 * @returns Queued state or the result of the same previously accepted approval.
 */
export async function approveMiraSocial(
    context: MiraContext,
    input: MiraSocialApprove,
    binding?: MoltbookBinding
): Promise<MiraSocialDraft> {
    human(context);
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
                content: MiraSocialContent;
                conversationId: string | null;
            }[]
        >`SELECT version,state,content,content_hash AS hash,binding_hash AS binding,approved_version AS "approvedVersion",conversation_id AS "conversationId" FROM mira_social_drafts WHERE id=${input.id} AND owner=${context.owner} FOR UPDATE`;
        if (!row) throw new MiraFailure("NOT_FOUND", "Moltbook draft not found.");
        if (
            row.hash !== input.contentHash ||
            miraSocialHash(row.content) !== row.hash ||
            miraSocialHash(input.reviewedContent) !== row.hash
        )
            throw new MiraFailure(
                "CONFLICT",
                "This draft changed. Review its current text and destination."
            );
        if (row.approvedVersion === input.version)
            return readDraft(query, context.owner, input.id);
        if (
            row.state !== "draft" ||
            row.version !== input.version ||
            row.binding !== moltbookBindingHash(configured)
        )
            throw new MiraFailure(
                "CONFLICT",
                "This draft changed or belongs to a previous Moltbook account."
            );
        await requireConversation(query, context.owner, row.conversationId);
        const stamp = await socialPermission(query, configured);
        if (stamp === null)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Enable Moltbook reads and publishing with a connected publishing credential first."
            );
        await query`UPDATE mira_social_drafts SET state='queued',message=NULL,retry_after=NULL,approved_version=version,approved_by=${context.actor},approved_at=clock_timestamp(),control_stamp=${stamp},version=version+1,updated_at=now() WHERE id=${input.id}`;
        await auditMira(query, context, "social.approved", input.id);
        return readDraft(query, context.owner, input.id);
    });
}
/**
 * Queue one explicit answer for an unexpired provider challenge on the already approved content.
 * @param context - Signed-in human; provider instructions never grant model authority.
 * @param input - Displayed draft version and fixed-format numeric answer.
 * @param binding - Current configured agent mapping.
 * @returns Durable verification queue state; this never creates another post or comment.
 */
export async function verifyMiraSocial(
    context: MiraContext,
    input: MiraSocialVerify,
    binding?: MoltbookBinding
): Promise<MiraSocialDraft> {
    human(context);
    const configured = bindingFor(context, binding);
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const stamp = await socialPermission(query, configured);
        if (stamp === null)
            throw new MiraFailure(
                "FORBIDDEN",
                "Moltbook publishing is paused or unavailable."
            );
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_social_drafts SET state='queued_verification',answer=${input.answer},version=version+1,updated_at=now() WHERE id=${input.id} AND owner=${context.owner} AND version=${input.version} AND state='verification_required' AND expires_at>clock_timestamp() AND approved_at>clock_timestamp()-interval '15 minutes' AND binding_hash=${moltbookBindingHash(configured)} AND control_stamp=${stamp} RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "The challenge expired, access changed or this draft already advanced. Refresh its status."
            );
        await auditMira(query, context, "social.verification_queued", input.id);
        return readDraft(query, context.owner, input.id);
    });
}
/**
 * Cancel local delivery before a provider request starts; existing provider content is not deleted.
 * @param context - Signed-in operator.
 * @param input - Current draft identity and expected version.
 * @returns Completion after a version-checked cancellation.
 */
export async function cancelMiraSocial(
    context: MiraContext,
    input: { id: string; version: number }
): Promise<void> {
    human(context);
    await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_social_drafts SET state='cancelled',answer=NULL,verification_code=NULL,message='Local delivery cancelled. Existing Moltbook content has not been deleted.',version=version+1,updated_at=now() WHERE id=${input.id} AND owner=${context.owner} AND version=${input.version} AND state IN ('draft','queued','verification_required','queued_verification') RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "This draft changed or a provider request already started."
            );
        await auditMira(query, context, "social.cancelled", input.id);
    });
}
