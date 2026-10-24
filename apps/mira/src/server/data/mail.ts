import {
    miraMailContentSchema,
    type MiraMailContent,
    type MiraMailDraft,
    type MiraMailSave,
} from "@homelab/contracts/miraMail";
import * as v from "valibot";

import {
    agentMailBindingHash,
    type AgentMailBinding,
} from "../integrations/agentmail/configuration";
import {
    auditMira,
    MiraFailure,
    miraTransaction,
    requireConversation,
    type MiraContext,
    type MiraQuery,
} from "./context";
import { agentMailBindingStatus, agentMailReceiverCurrent } from "./integrations";

/**
 * Fingerprint the exact normalized recipients and plain-text body shown for approval.
 * @param content - Validated draft content; no provider defaults or hidden recipients.
 * @returns Stable SHA-256 identity used by the human approval boundary.
 */
export function miraMailHash(content: MiraMailContent): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(v.parse(miraMailContentSchema, content)))
        .digest("hex");
}

function bindingFor(context: MiraContext, binding?: AgentMailBinding): AgentMailBinding {
    if (!binding || binding.owner !== context.owner)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "AgentMail is not configured for this account."
        );
    return binding;
}

async function readDraft(
    query: MiraQuery,
    owner: string,
    id: string
): Promise<MiraMailDraft> {
    const [row] = await query<
        MiraMailDraft[]
    >`SELECT id,inbox_id AS "inboxId",version,state,content,content_hash AS "contentHash",conversation_id AS "conversationId",message,provider_message_id AS "providerMessageId",created_at::text AS "createdAt",updated_at::text AS "updatedAt" FROM mira_mail_drafts WHERE id=${id} AND owner=${owner}`;
    if (!row) throw new MiraFailure("NOT_FOUND", "Mail draft not found.");
    return row;
}

/**
 * Save an owned local draft without invoking the provider or granting send authority.
 * @param context - Human owner or fenced transactional assistant tool context.
 * @param input - Stable draft identity, expected version and complete proposed content.
 * @param binding - Provisioned inbox; rebinding never silently moves an existing draft.
 * @returns Saved draft; an identical create retry returns the original record.
 */
export async function saveMiraMail(
    context: MiraContext,
    input: MiraMailSave,
    binding?: AgentMailBinding
): Promise<MiraMailDraft> {
    const configured = bindingFor(context, binding);
    const content = v.parse(miraMailContentSchema, input.content);
    const hash = miraMailHash(content);
    const bindingHash = agentMailBindingHash(configured);
    return miraTransaction(context, async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:mail:${context.owner}:${input.id}`},0))`;
        const [existing] = await query<
            {
                owner: string;
                version: number;
                state: string;
                hash: string;
                binding: string;
                conversationId: string | null;
            }[]
        >`SELECT owner,version,state,content_hash AS hash,binding_hash AS binding,conversation_id AS "conversationId" FROM mira_mail_drafts WHERE id=${input.id} FOR UPDATE`;
        if (existing) {
            if (existing.owner !== context.owner)
                throw new MiraFailure("NOT_FOUND", "Mail draft not found.");
            if (
                input.version === 0 &&
                existing.hash === hash &&
                existing.binding === bindingHash &&
                existing.conversationId === input.conversationId
            )
                return readDraft(query, context.owner, input.id);
            if (
                existing.version !== input.version ||
                existing.state !== "draft" ||
                existing.binding !== bindingHash
            )
                throw new MiraFailure(
                    "CONFLICT",
                    "This draft changed or already entered delivery. Refresh before editing."
                );
        } else if (input.version !== 0)
            throw new MiraFailure("NOT_FOUND", "Mail draft not found.");
        await requireConversation(query, context.owner, input.conversationId);
        await (existing
            ? query`UPDATE mira_mail_drafts SET content=${JSON.stringify(content)}::text::jsonb,content_hash=${hash},conversation_id=${input.conversationId},version=version+1,updated_at=now() WHERE id=${input.id}`
            : query`INSERT INTO mira_mail_drafts (id,owner,conversation_id,inbox_id,binding_hash,content,content_hash) VALUES (${input.id},${context.owner},${input.conversationId},${configured.inboxId},${bindingHash},${JSON.stringify(content)}::text::jsonb,${hash})`);
        await auditMira(query, context, "mail.draft_saved", input.id);
        return readDraft(query, context.owner, input.id);
    });
}

/**
 * Read a bounded page of local drafts and delivery outcomes for the current operator.
 * @param context - Verified owner; mail bodies never cross owner boundaries.
 * @param filter - Optional conversation and descending stable pagination cursor.
 * @returns Local drafts with no provider call or implicit send.
 */
export async function listMiraMail(
    context: MiraContext,
    filter: { before?: string | undefined; conversationId?: string | undefined }
) {
    const rows = await context.client<
        MiraMailDraft[]
    >`SELECT id,inbox_id AS "inboxId",version,state,content,content_hash AS "contentHash",conversation_id AS "conversationId",message,provider_message_id AS "providerMessageId",created_at::text AS "createdAt",updated_at::text AS "updatedAt" FROM mira_mail_drafts WHERE owner=${context.owner} AND (${filter.before ?? null}::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM mira_mail_drafts WHERE id=${filter.before ?? null}::uuid AND owner=${context.owner})) AND (${filter.conversationId ?? null}::uuid IS NULL OR conversation_id=${filter.conversationId ?? null}::uuid) ORDER BY created_at DESC,id DESC LIMIT 20`;
    return { rows, nextCursor: rows.length === 20 ? rows.at(-1)!.id : null };
}

/**
 * Queue only the exact draft version and body explicitly reviewed by its human owner.
 * @param context - Human-only product context; model tools cannot call this action.
 * @param input - Draft version and displayed content fingerprint.
 * @param binding - Dashboard's configured receiver, matched against the live executor.
 * @returns Current draft state; an approval retry never schedules a second delivery.
 */
export async function approveMiraMail(
    context: MiraContext,
    input: { id: string; version: number; contentHash: string },
    binding?: AgentMailBinding
): Promise<MiraMailDraft> {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Sending mail requires the operator's confirmation."
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
            }[]
        >`SELECT version,state,content_hash AS hash,binding_hash AS binding,approved_version AS "approvedVersion" FROM mira_mail_drafts WHERE id=${input.id} AND owner=${context.owner} FOR UPDATE`;
        if (!row) throw new MiraFailure("NOT_FOUND", "Mail draft not found.");
        if (row.hash !== input.contentHash)
            throw new MiraFailure(
                "CONFLICT",
                "The email changed. Review the current recipients and content before sending."
            );
        if (row.approvedVersion === input.version)
            return readDraft(query, context.owner, input.id);
        if (
            row.state !== "draft" ||
            row.version !== input.version ||
            row.binding !== agentMailBindingHash(configured)
        )
            throw new MiraFailure(
                "CONFLICT",
                "This draft changed or belongs to a previous inbox. Refresh before sending."
            );
        const status = await agentMailBindingStatus(query, configured);
        if (
            !status.enabled ||
            !status.granted ||
            !status.matched ||
            !status.fresh ||
            !(await agentMailReceiverCurrent(query, configured))
        )
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "AgentMail must be enabled and connected before sending."
            );
        const [control] = await query<
            { version: number }[]
        >`SELECT version FROM mira_switches WHERE owner=${context.owner} AND key='integration:agentmail'`;
        await query`UPDATE mira_mail_drafts SET state='queued',approved_version=version,approved_by=${context.actor},approved_at=now(),control_version=${control!.version},version=version+1,updated_at=now() WHERE id=${input.id}`;
        await auditMira(query, context, "mail.send_approved", input.id);
        return readDraft(query, context.owner, input.id);
    });
}

/**
 * Discard a draft or cancel an approval that has not entered the provider request.
 * @param context - Human owner; an in-flight or uncertain send is never reported cancelled.
 * @param input - Current identity and expected version.
 * @returns Completion after cancellation commits under the same dispatch lock.
 */
export async function cancelMiraMail(
    context: MiraContext,
    input: { id: string; version: number }
): Promise<void> {
    if (context.run)
        throw new MiraFailure("FORBIDDEN", "Only the operator can cancel mail delivery.");
    await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_mail_drafts SET state='cancelled',message='Cancelled before sending.',version=version+1,updated_at=now() WHERE id=${input.id} AND owner=${context.owner} AND version=${input.version} AND state IN ('draft','queued') RETURNING id`;
        if (!rows[0])
            throw new MiraFailure(
                "CONFLICT",
                "This draft changed or sending has already started. Refresh to see its outcome."
            );
        await auditMira(query, context, "mail.cancelled", input.id);
    });
}
