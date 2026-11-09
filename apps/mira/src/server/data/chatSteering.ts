import type { miraMessageInputSchema } from "@homelab/contracts/mira";
import type { SQL, TransactionSQL } from "bun";
import type * as v from "valibot";

import { auditMira, type MiraContext, MiraFailure } from "./context";
import { enqueueTurn } from "./conversations";
import type { MiraClaim } from "./queue";

/**
 * Send a new turn or persist guidance for the current manual conversation run.
 * @param context - Verified human account and product database.
 * @param input - Validated text, owned attachments and idempotency key.
 * @returns The owning run ID; pending guidance remains visible across clients.
 */
export async function sendMiraMessage(
    context: MiraContext,
    input: v.InferOutput<typeof miraMessageInputSchema>
) {
    return context.client.begin(async (query) => {
        const key = `${context.owner}:${input.requestId}`;
        const hash = new Bun.CryptoHasher("sha256")
            .update(JSON.stringify(input))
            .digest("hex");
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:request:${key}`},0))`;
        const [existing] = await query<{ id: string; hash: string }[]>`
            SELECT run_id AS id,request_hash AS hash FROM mira_chat_inputs WHERE request_key=${key}
            UNION ALL SELECT id,request_hash AS hash FROM mira_runs WHERE request_key=${key}`;
        if (existing) {
            if (existing.hash !== hash)
                throw new MiraFailure(
                    "CONFLICT",
                    "This request identifier already belongs to another message."
                );
            return { id: existing.id };
        }
        const [chat] = await query<
            { id: string }[]
        >`SELECT id FROM mira_conversations WHERE id=${input.conversationId} AND owner=${context.owner} AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`;
        if (!chat)
            throw new MiraFailure(
                "NOT_FOUND",
                "Open an active conversation before sending."
            );
        let [run] = await query<
            {
                id: string;
                manual: boolean;
                automationId: string | null;
                cancelled: boolean;
            }[]
        >`SELECT id,manual,automation_id AS "automationId",cancel_requested AS cancelled FROM mira_runs WHERE conversation_id=${chat.id} AND owner=${context.owner} AND state IN ('queued','running') FOR UPDATE`;
        if (!run) {
            // Admission and the scheduler share the conversation lock. Never let a
            // newly submitted message overtake an older, unconsumed follow-up.
            const pending = await query<
                { id: string; owner: string; conversationId: string }[]
            >`
                SELECT id,owner,conversation_id AS "conversationId" FROM mira_chat_inputs
                WHERE conversation_id=${chat.id} AND owner=${context.owner} AND state IN ('pending','sending') ORDER BY id`;
            for (const candidate of pending) {
                const [lock] = await query<{ acquired: boolean }[]>`
                    SELECT pg_try_advisory_xact_lock(hashtextextended(${`mira:request:${candidate.owner}:${candidate.id}`},0)) AS acquired`;
                if (!lock?.acquired)
                    throw new MiraFailure(
                        "CONFLICT",
                        "An earlier message is being queued. Retry shortly."
                    );
                const next = await continueChatFollowup(query, candidate);
                if (next) {
                    run = {
                        id: next.id,
                        manual: true,
                        automationId: null,
                        cancelled: false,
                    };
                    break;
                }
            }
            if (!run) return enqueueTurn(query, context, input);
        }
        if (!run.manual || run.automationId || run.cancelled)
            throw new MiraFailure(
                "CONFLICT",
                "Wait for the stopped or automatic run to finish before sending."
            );
        const [count] = await query<
            { total: number }[]
        >`SELECT count(*)::int AS total FROM mira_chat_inputs WHERE conversation_id=${chat.id} AND state IN ('pending','sending')`;
        if ((count?.total ?? 0) >= 20)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "There are already 20 pending messages. Wait for Mira to read them."
            );
        for (const id of input.attachmentIds) {
            const [file] = await query<
                { id: string }[]
            >`SELECT id FROM mira_attachments WHERE id=${id} AND owner=${context.owner} AND deleted_at IS NULL AND ready_at IS NOT NULL FOR SHARE`;
            if (!file)
                throw new MiraFailure(
                    "NOT_FOUND",
                    "An attachment is no longer available."
                );
        }
        const id = Bun.randomUUIDv7();
        await query`INSERT INTO mira_messages(id,conversation_id,role,content,state,attachment_ids) VALUES (${id},${chat.id},'user',${input.text},'queued',${JSON.stringify(input.attachmentIds)}::text::jsonb)`;
        await query`INSERT INTO mira_chat_inputs(id,owner,conversation_id,run_id,request_key,request_hash) VALUES (${id},${context.owner},${chat.id},${run.id},${key},${hash})`;
        await query`UPDATE mira_conversations SET version=version+1,updated_at=clock_timestamp() WHERE id=${chat.id}`;
        await auditMira(query, context, "chat.guidance_queued", id);
        return { id: run.id };
    });
}

/**
 * Claim the oldest text-only guidance once for a live provider turn.
 * @param client - Executor database connection.
 * @param run - Current manual run and fencing token.
 * @returns The message to steer, or null; attachments wait for a subsequent turn.
 */
export async function claimChatSteering(client: SQL, run: MiraClaim) {
    if (!run.manual || run.automationId) return null;
    return client.begin(async (query) => {
        const [live] = await query<
            { id: string }[]
        >`SELECT r.id FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner WHERE r.id=${run.id} AND r.owner=${run.owner} AND r.state='running' AND NOT r.cancel_requested AND r.lease_token=${run.leaseToken} AND r.lease_expires_at>clock_timestamp() AND c.deleted_at IS NULL AND c.archived_at IS NULL FOR SHARE OF r`;
        if (!live) return null;
        const [input] = await query<
            { id: string; content: string; attachments: number }[]
        >`SELECT i.id,m.content,jsonb_array_length(m.attachment_ids) AS attachments FROM mira_chat_inputs i JOIN mira_messages m ON m.id=i.id JOIN mira_runs old ON old.id=i.run_id AND old.owner=i.owner WHERE i.owner=${run.owner} AND i.conversation_id=${run.conversationId} AND i.state='pending' AND (i.run_id=${run.id} OR (old.state='completed' AND NOT old.cancel_requested)) ORDER BY i.id LIMIT 1 FOR UPDATE OF i`;
        if (!input || input.attachments) return null;
        await query`UPDATE mira_chat_inputs SET state='sending',run_id=${run.id},lease_token=${run.leaseToken} WHERE id=${input.id}`;
        return { id: input.id, content: input.content };
    });
}

/**
 * Record exact provider acceptance; a late message remains pending for the next turn.
 * @param client - Executor database connection.
 * @param run - The lease that sent this guidance.
 * @param id - Claimed product message, never a model-selected reference.
 * @param accepted - Whether the provider acknowledged the active turn.
 * @returns Whether the fenced acknowledgement was stored.
 */
export async function acknowledgeChatSteering(
    client: SQL,
    run: MiraClaim,
    id: string,
    accepted: boolean
) {
    return client.begin(async (query) => {
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_chat_inputs i SET state=${accepted ? "delivered" : "pending"},lease_token=NULL WHERE i.id=${id} AND i.owner=${run.owner} AND i.run_id=${run.id} AND i.state='sending' AND i.lease_token=${run.leaseToken} AND EXISTS(SELECT 1 FROM mira_runs r WHERE r.id=i.run_id AND r.state='running' AND NOT r.cancel_requested AND r.lease_token=${run.leaseToken} AND r.lease_expires_at>clock_timestamp()) RETURNING i.id`;
        if (rows.length === 0) return false;
        if (accepted)
            await query`UPDATE mira_messages SET state='completed' WHERE id=${id} AND conversation_id=${run.conversationId}`;
        return true;
    });
}

/**
 * Continue late or attachment-bearing messages after a completed run, without replaying failed work.
 * @param client - Executor connection; every candidate is rechecked under the conversation lock.
 * @returns The number of newly queued follow-up turns.
 */
export async function scheduleChatFollowups(client: SQL) {
    const candidates = await client<
        { id: string; owner: string; conversationId: string }[]
    >`SELECT i.id,i.owner,i.conversation_id AS "conversationId" FROM mira_chat_inputs i JOIN mira_runs r ON r.id=i.run_id WHERE i.state IN ('pending','sending') AND i.next_attempt_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM mira_chat_inputs older WHERE older.conversation_id=i.conversation_id AND older.owner=i.owner AND older.state IN ('pending','sending') AND older.id<i.id) AND r.state NOT IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM mira_runs active WHERE active.conversation_id=i.conversation_id AND active.state IN ('queued','running')) ORDER BY i.id LIMIT 20`;
    let count = 0;
    for (const candidate of candidates) {
        count += await client.begin(async (query) => {
            const [lock] = await query<
                { acquired: boolean }[]
            >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`mira:request:${candidate.owner}:${candidate.id}`},0)) AS acquired`;
            if (!lock?.acquired) return 0;
            await query`SELECT id FROM mira_conversations WHERE id=${candidate.conversationId} AND owner=${candidate.owner} FOR UPDATE`;
            const [busy] = await query<{ id: string }[]>`
                SELECT id FROM mira_runs WHERE conversation_id=${candidate.conversationId} AND state IN ('queued','running') LIMIT 1`;
            if (busy) return 0;
            try {
                return (await continueChatFollowup(query, candidate)) ? 1 : 0;
            } catch (error) {
                if (!(error instanceof MiraFailure)) throw error;
                await query`UPDATE mira_chat_inputs SET next_attempt_at=clock_timestamp()+interval '30 seconds' WHERE id=${candidate.id} AND state IN ('pending','sending')`;
                return 0;
            }
        });
    }
    return count;
}

// Caller holds the conversation and follow-up request locks. A transient failure
// keeps the oldest message pending; terminal/unacknowledged work is never replayed.
async function continueChatFollowup(
    query: TransactionSQL,
    candidate: { id: string; owner: string; conversationId: string }
) {
    const [input] = await query<
        {
            content: string;
            attachmentIds: string[];
            state: string;
            runState: string;
            cancelled: boolean;
            available: boolean;
        }[]
    >`SELECT m.content,m.attachment_ids AS "attachmentIds",i.state,r.state AS "runState",r.cancel_requested AS cancelled,(c.deleted_at IS NULL AND c.archived_at IS NULL) AS available FROM mira_chat_inputs i JOIN mira_messages m ON m.id=i.id JOIN mira_runs r ON r.id=i.run_id AND r.owner=i.owner JOIN mira_conversations c ON c.id=i.conversation_id AND c.owner=i.owner WHERE i.id=${candidate.id} AND i.owner=${candidate.owner} AND i.state IN ('pending','sending') AND i.id=(SELECT older.id FROM mira_chat_inputs older WHERE older.owner=i.owner AND older.conversation_id=i.conversation_id AND older.state IN ('pending','sending') ORDER BY older.id LIMIT 1) FOR UPDATE OF i`;
    if (!input || ["queued", "running"].includes(input.runState)) return null;
    if (
        !input.available ||
        input.cancelled ||
        input.runState !== "completed" ||
        input.state === "sending"
    ) {
        await query`UPDATE mira_chat_inputs SET state='stopped',lease_token=NULL WHERE id=${candidate.id}`;
        await query`UPDATE mira_messages SET state='interrupted' WHERE id=${candidate.id}`;
        return null;
    }
    try {
        return await query.savepoint(async (nested) => {
            const next = await enqueueTurn(
                nested,
                { owner: candidate.owner, actor: `human:${candidate.owner}` },
                {
                    conversationId: candidate.conversationId,
                    requestId: candidate.id,
                    text: input.content,
                    attachmentIds: input.attachmentIds,
                },
                { userMessageId: candidate.id }
            );
            await nested`UPDATE mira_chat_inputs SET state='continued',run_id=${next.id} WHERE id=${candidate.id}`;
            return next;
        });
    } catch (error) {
        if (!(error instanceof MiraFailure)) throw error;
        if (
            !error.retryable ||
            ["NOT_FOUND", "BAD_REQUEST", "FORBIDDEN"].includes(error.code)
        ) {
            await query`UPDATE mira_chat_inputs SET state='stopped',lease_token=NULL WHERE id=${candidate.id}`;
            await query`UPDATE mira_messages SET state='interrupted' WHERE id=${candidate.id}`;
        } else throw error;
        return null;
    }
}
