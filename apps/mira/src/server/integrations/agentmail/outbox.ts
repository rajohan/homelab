import { miraMailContentSchema, type MiraMailContent } from "@homelab/contracts/miraMail";
import { publishNotification } from "@homelab/notifications";
import type { SQL } from "bun";
import * as v from "valibot";

import { miraActionApproval } from "../../data/approvalPolicy";
import { agentMailReceiverCurrent } from "../../data/integrations";
import { miraMailHash } from "../../data/mail";
import { miraMailRequestBody, verifyMailAttachments } from "../../data/mailAttachments";
import { integrationJson } from "../http";
import { agentMailBindingHash, type AgentMailReadConfiguration } from "./configuration";
import { AgentMailReader } from "./reader";
import { agentMailIdSchema } from "./schema";

const unknownMessage =
    "Delivery could not be confirmed. Check the sent mailbox before taking any further action; this email will not be sent again automatically.";

/**
 * Reconcile abandoned sends and invalidate approvals independently of provider availability.
 * @param client - Product pool; one durable notification is published per abandoned attempt.
 * @param configuration - Current executor binding, absent when AgentMail has been removed.
 * @returns Completion after bounded reconciliation; no network retry is performed.
 */
export async function reconcileMiraMail(
    client: SQL,
    configuration?: AgentMailReadConfiguration
): Promise<void> {
    await client.begin(async (query) => {
        const rows = await query<
            { id: string; owner: string; token: string }[]
        >`UPDATE mira_mail_drafts SET state='needs_attention',message=${unknownMessage},version=version+1,updated_at=now() WHERE id IN (SELECT id FROM mira_mail_drafts WHERE state='sending' AND started_at<now()-interval '2 minutes' ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING id,owner,attempt_token AS token`;
        for (const row of rows)
            await publishNotification(
                query,
                "mira-mail",
                {
                    key: `${row.id}:${row.token}`,
                    title: "Email delivery needs review",
                    message: unknownMessage,
                    severity: "warning",
                    destination: "mira",
                },
                `human:${row.owner}`
            );
    });
    const binding = configuration ? agentMailBindingHash(configuration) : null;
    const candidates = await client<
        { id: string; owner: string }[]
    >`SELECT id,owner FROM mira_mail_drafts WHERE state='queued' OR (state='draft' AND (EXISTS(SELECT 1 FROM mira_integration_receivers receiver WHERE receiver.key='agentmail' AND receiver.binding_hash IS DISTINCT FROM mira_mail_drafts.binding_hash) OR (NOT EXISTS(SELECT 1 FROM mira_integration_receivers WHERE key='agentmail') AND (${configuration?.owner ?? null}::text IS NULL OR owner<>${configuration?.owner ?? null} OR binding_hash<>${binding})))) ORDER BY approved_at NULLS LAST,id LIMIT 50`;
    for (const candidate of candidates) {
        await client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${candidate.owner}`},0))`;
            const [row] = await query<
                {
                    binding: string;
                    state: string;
                    controlVersion: number | null;
                    fresh: boolean;
                }[]
            >`SELECT binding_hash AS binding,state,control_version AS "controlVersion",approved_at>now()-interval '15 minutes' AS fresh FROM mira_mail_drafts WHERE id=${candidate.id} AND owner=${candidate.owner} AND state IN ('draft','queued') FOR UPDATE`;
            if (!row) return;
            const [receiver] = await query<
                { binding: string | null }[]
            >`SELECT binding_hash AS binding FROM mira_integration_receivers WHERE key='agentmail' FOR SHARE`;
            const executorMatches =
                configuration !== undefined &&
                configuration.owner === candidate.owner &&
                row.binding === binding;
            const obsolete = receiver
                ? receiver.binding !== row.binding
                : !executorMatches;
            if (obsolete) {
                await query`UPDATE mira_mail_drafts SET state='cancelled',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,message='AgentMail was removed or its inbox changed. This email was cancelled before sending. Create a new draft for the current inbox if needed.',version=version+1,updated_at=now() WHERE id=${candidate.id}`;
                return;
            }
            // Expiry and access revocation remain authoritative while executors roll over.
            if (row.state !== "queued") return;
            const [control] = await query<
                { enabled: boolean; version: number; binding: string | null }[]
            >`SELECT enabled,version,binding_hash AS binding FROM mira_switches WHERE owner=${candidate.owner} AND key='integration:agentmail'`;
            if (
                (executorMatches && !configuration?.sendApiKey) ||
                !row.fresh ||
                !(await miraActionApproval(
                    query,
                    candidate.owner,
                    "mail",
                    candidate.id
                )) ||
                !control?.enabled ||
                control.version !== row.controlVersion ||
                control.binding !== row.binding
            )
                await query`UPDATE mira_mail_drafts SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,message='Delivery approval expired or AgentMail access changed. Review this draft again before sending.',version=version+1,updated_at=now() WHERE id=${candidate.id}`;
        });
    }
}

/**
 * Attempt one explicitly approved email exactly once, independently of model availability.
 * @param client - Durable product pool shared by admission and recovery.
 * @param configuration - Fixed executor credential and inbox; never taken from draft content.
 * @param signal - Service shutdown; uncertain transport outcomes are never replayed.
 * @param request - Fixed-origin HTTP transport, injectable only for synthetic qualification.
 * @param filesDirectory - Shared private file volume used only for explicitly approved attachments.
 * @returns Whether an approved delivery was claimed; provider acceptance is recorded separately.
 */
export async function dispatchMiraMail(
    client: SQL,
    configuration: AgentMailReadConfiguration,
    signal: AbortSignal,
    request: typeof fetch = fetch,
    filesDirectory?: string
): Promise<boolean> {
    signal.throwIfAborted();
    if (!configuration.sendApiKey) return false;
    const claimed = await client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${configuration.owner}`},0))`;
        if (!(await agentMailReceiverCurrent(query, configuration))) return null;
        const [control] = await query<
            { enabled: boolean; version: number; binding: string | null }[]
        >`SELECT enabled,version,binding_hash AS binding FROM mira_switches WHERE owner=${configuration.owner} AND key='integration:agentmail'`;
        const [row] = await query<
            {
                id: string;
                binding: string;
                controlVersion: number;
                fresh: boolean;
                content: MiraMailContent;
                hash: string;
            }[]
        >`SELECT id,binding_hash AS binding,control_version AS "controlVersion",approved_at>now()-interval '15 minutes' AS fresh,content,content_hash AS hash FROM mira_mail_drafts WHERE owner=${configuration.owner} AND state='queued' AND (retry_after IS NULL OR retry_after<=clock_timestamp()) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!row) return null;
        if (row.binding !== agentMailBindingHash(configuration)) {
            await query`UPDATE mira_mail_drafts SET state='cancelled',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,message='The AgentMail inbox changed. This email was cancelled before sending. Create a new draft for the current inbox if needed.',version=version+1,updated_at=now() WHERE id=${row.id}`;
            return null;
        }
        if (
            !row.fresh ||
            !(await miraActionApproval(query, configuration.owner, "mail", row.id)) ||
            !control?.enabled ||
            control.version !== row.controlVersion ||
            control.binding !== row.binding
        ) {
            await query`UPDATE mira_mail_drafts SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,message='Delivery approval expired or AgentMail changed. Review this draft again before sending.',version=version+1,updated_at=now() WHERE id=${row.id}`;
            return null;
        }

        const content = v.parse(miraMailContentSchema, row.content);
        if (miraMailHash(content) !== row.hash)
            throw new Error("The approved email content no longer matches.");
        if (content.reply) {
            let latest: string;
            try {
                latest = await new AgentMailReader(
                    configuration,
                    request
                ).latestMessageId(content.reply.threadId, signal);
            } catch {
                // Defer only this reply so a failed read cannot monopolize the outbox.
                signal.throwIfAborted();
                await query`UPDATE mira_mail_drafts SET retry_after=clock_timestamp()+interval '30 seconds' WHERE id=${row.id}`;
                return null;
            }
            if (latest !== content.reply.messageId) {
                await query`UPDATE mira_mail_drafts SET state='cancelled',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,message='The email thread received a newer message. Create and review a new reply before sending.',version=version+1,updated_at=now() WHERE id=${row.id}`;
                return null;
            }
        }
        let body: string;
        try {
            const context = {
                client,
                transaction: query,
                owner: configuration.owner,
                actor: "mira:mail",
            };
            await verifyMailAttachments(query, context, content.attachments ?? []);
            body = await miraMailRequestBody(context, filesDirectory, content);
        } catch {
            await query`UPDATE mira_mail_drafts SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,message='The email attachments could not be verified. Check the selected files, save and review the draft again.',version=version+1,updated_at=now() WHERE id=${row.id}`;
            return null;
        }
        signal.throwIfAborted();
        if (!(await miraActionApproval(query, configuration.owner, "mail", row.id)))
            return null;
        const token = crypto.randomUUID();
        const admitted = await query<
            { id: string }[]
        >`UPDATE mira_mail_drafts SET state='sending',attempt_token=${token},retry_after=NULL,started_at=clock_timestamp(),message=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=${row.id} AND approved_at>clock_timestamp()-interval '15 minutes' RETURNING id`;
        if (!admitted[0]) {
            await query`UPDATE mira_mail_drafts SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,retry_after=NULL,message='Delivery approval expired. Review this draft again before sending.',version=version+1,updated_at=clock_timestamp() WHERE id=${row.id}`;
            return null;
        }
        return { id: row.id, token, body, reply: content.reply };
    });
    if (!claimed) return false;
    if (signal.aborted) {
        // No transport was invoked: retain the approval for ordinary dispatch revalidation.
        await client`UPDATE mira_mail_drafts SET state='queued',attempt_token=NULL,started_at=NULL,version=version+1,updated_at=now() WHERE id=${claimed.id} AND owner=${configuration.owner} AND attempt_token=${claimed.token} AND state='sending'`;
        return true;
    }
    if (!(await miraActionApproval(client, configuration.owner, "mail", claimed.id))) {
        await client`UPDATE mira_mail_drafts SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,attempt_token=NULL,started_at=NULL,message='Chat permission changed. Review this email again.',version=version+1,updated_at=now() WHERE id=${claimed.id} AND owner=${configuration.owner} AND attempt_token=${claimed.token} AND state='sending'`;
        return true;
    }
    let acknowledgement: { message_id: string; thread_id: string } | null = null;
    try {
        signal.throwIfAborted();
        const response = await request(
            `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(configuration.inboxId)}/messages/${claimed.reply ? `${encodeURIComponent(claimed.reply.messageId)}/reply` : "send"}`,
            {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                headers: {
                    Authorization: `Bearer ${configuration.sendApiKey}`,
                    "Content-Type": "application/json",
                    "Idempotency-Key": `mira-mail-${claimed.id}`,
                    Accept: "application/json",
                },
                body: claimed.body,
            }
        );
        acknowledgement = v.parse(
            v.object({ message_id: agentMailIdSchema, thread_id: agentMailIdSchema }),
            await integrationJson(response, 65_536)
        );
    } catch {
        // Provider idempotency expires after 24 hours; keep ambiguous outcomes for review.
    }
    const accepted =
        acknowledgement !== null &&
        (!claimed.reply || acknowledgement.thread_id === claimed.reply.threadId);
    await client.begin(async (query) => {
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_mail_drafts SET state=${accepted ? "sent" : "needs_attention"},provider_message_id=${acknowledgement?.message_id ?? null},provider_thread_id=${acknowledgement?.thread_id ?? null},message=${accepted ? "Accepted by AgentMail. Recipient delivery is not yet confirmed." : unknownMessage},version=version+1,updated_at=now() WHERE id=${claimed.id} AND owner=${configuration.owner} AND attempt_token=${claimed.token} AND state IN ('sending','needs_attention') RETURNING id`;
        if (rows[0] && !accepted)
            await publishNotification(
                query,
                "mira-mail",
                {
                    key: `${claimed.id}:${claimed.token}`,
                    title: "Email delivery needs review",
                    message: unknownMessage,
                    severity: "warning",
                    destination: "mira",
                },
                `human:${configuration.owner}`
            );
    });
    return true;
}
