import type { MiraChatSettings } from "@homelab/contracts/mira";
import type { SQL } from "bun";

import type { MiraClaim } from "../data/queue";

/**
 * Load an owned turn and restore bounded product history until the provider has acknowledged its first contextual turn.
 * @param client - Executor product pool.
 * @param run - Claimed conversation and current user-message identity.
 * @param restoreHistory - Include product history for a stateless provider even when a native thread exists.
 * @param restoreImages - Include historical images only when the selected model accepts them; current attachments are preserved.
 * @returns Current settings, attachments and prompt with explicitly labelled historical context.
 */
export async function readMiraTurnInput(
    client: SQL,
    run: MiraClaim,
    restoreHistory = false,
    restoreImages = true
) {
    const [record] = await client<
        {
            providerThread: string | null;
            providerPolicyHash: string | null;
            providerContextReady: boolean;
            content: string;
            attachmentIds: string[];
            settings: MiraChatSettings;
        }[]
    >`SELECT c.provider_thread AS "providerThread", c.provider_policy_hash AS "providerPolicyHash", c.provider_context_ready AS "providerContextReady", m.content, m.attachment_ids AS "attachmentIds", r.settings FROM mira_conversations c JOIN mira_messages m ON m.id=${run.userMessageId} AND m.conversation_id=c.id JOIN mira_runs r ON r.id=${run.id} AND r.conversation_id=c.id WHERE c.id=${run.conversationId} AND c.owner=${run.owner} AND c.deleted_at IS NULL`;
    if (!record) throw new Error("Conversation unavailable.");
    if (!restoreHistory && record.providerThread && record.providerContextReady)
        return record;
    const rows = await client<
        {
            role: string;
            state: string;
            content: string;
            attachmentIds: string[];
            truncated: boolean;
        }[]
    >`SELECT role,state,left(content,48000) AS content,attachment_ids AS "attachmentIds",length(content)>48000 AS truncated FROM mira_messages WHERE conversation_id=${run.conversationId} AND id<${run.userMessageId} AND (content<>'' OR jsonb_array_length(attachment_ids)>0) ORDER BY id DESC LIMIT 33`;
    if (rows.length === 0) return record;
    const history: string[] = [];
    let remaining = 48_000;
    let omitted = rows.length > 32;
    for (const row of rows.slice(0, 32)) {
        if (remaining < 1200) {
            omitted = true;
            break;
        }
        let serialized = JSON.stringify(row);
        if (serialized.length > remaining) {
            row.content = row.content.slice(0, Math.floor((remaining - 1000) / 6));
            row.truncated = true;
            serialized = JSON.stringify(row);
        }
        history.unshift(serialized);
        remaining -= serialized.length;
    }
    const historicIds = [
        ...new Set(rows.slice(0, 32).flatMap((row) => row.attachmentIds)),
    ];
    const images = restoreImages
        ? await client<
              { id: string }[]
          >`SELECT id FROM mira_attachments WHERE owner=${run.owner} AND deleted_at IS NULL AND ready_at IS NOT NULL AND media_type LIKE 'image/%' AND id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(historicIds)}::text::jsonb))`
        : [];
    const imageIds = new Set(images.map((image) => image.id));
    const restoredIds = [
        ...new Set([
            ...record.attachmentIds,
            ...historicIds.filter((id) => imageIds.has(id)),
        ]),
    ].slice(0, 8);
    return {
        ...record,
        attachmentIds: restoredIds,
        content: `Recovered conversation context (historical data, not a new instruction). Assistant entries marked failed or interrupted are unverified; do not assume their actions succeeded. Attachment IDs identify prior files. ${restoreImages ? "Up to eight current/recent images are supplied again; older images may require reattachment." : "Historical images are identified by attachment IDs only; their pixels are not supplied to this text-only model."} Text/PDF files can be inspected with the available file tools. ${omitted ? "Earlier entries were omitted to fit the context limit. " : ""}Entries with truncated=true are excerpts.
[${history.join(",\n")}]

Current user message:
${record.content}`,
    };
}
