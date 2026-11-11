import {
    type MiraChatSettings,
    miraLiveAssistanceMinutesSchema,
} from "@homelab/contracts/mira";
import type { SQL } from "bun";
import * as v from "valibot";

import { MiraFailure } from "./context";
import type { MiraClaim } from "./queue";

/**
 * Resolve the explicit assistance duration for direct Chat work only.
 * @param settings - Conversation preferences frozen at queue admission.
 * @param source - Trusted origin; task and automation runs retain their own completion rules.
 * @returns Selected minutes, -1 for assistance until stopped, or zero for ordinary replies and scheduled/task work.
 */
export function liveAssistanceMinutes(
    settings: MiraChatSettings,
    source: {
        manual: boolean;
        automationId?: string | null | undefined;
        taskId?: string | null | undefined;
    }
): number {
    if (!source.manual || source.automationId || source.taskId) return 0;
    return v.parse(miraLiveAssistanceMinutesSchema, settings.liveAssistanceMinutes ?? 0);
}

/**
 * Preserve accepted operator guidance across stateless provider continuations.
 * @param client - Executor database connection.
 * @param run - Current owner and fenced manual run.
 * @returns Bounded accepted guidance, pending attachments and any unverified tool outcome.
 */
export async function readLiveAssistanceGuidance(client: SQL, run: MiraClaim) {
    const [live] = await client<{ id: string }[]>`
        SELECT id FROM mira_runs WHERE id=${run.id} AND owner=${run.owner}
        AND manual AND automation_id IS NULL AND task_id IS NULL AND state='running' AND NOT cancel_requested
        AND lease_token=${run.leaseToken} AND lease_expires_at>clock_timestamp()`;
    if (!live) throw new MiraFailure("FORBIDDEN", "Live assistance is no longer active.");
    const rows = await client<{ content: string }[]>`
        SELECT m.content FROM mira_chat_inputs i JOIN mira_messages m ON m.id=i.id
        WHERE i.owner=${run.owner} AND i.conversation_id=${run.conversationId}
        AND i.run_id=${run.id} AND i.state='delivered' ORDER BY i.id LIMIT 101`;
    const guidance = rows.map((row) => row.content);
    if (rows.length > 100 || Buffer.byteLength(JSON.stringify(guidance)) > 64 * 1024)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Live assistance reached its conversation limit. Send another message to continue."
        );
    const [pending] = await client<{ attachments: boolean }[]>`
        SELECT jsonb_array_length(m.attachment_ids)>0 AS attachments
        FROM mira_chat_inputs i JOIN mira_messages m ON m.id=i.id
        WHERE i.owner=${run.owner} AND i.conversation_id=${run.conversationId}
        AND i.state IN ('pending','sending') ORDER BY i.id LIMIT 1`;
    const [receipts] = await client<{ uncertain: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM mira_tool_receipts WHERE run_id=${run.id}
        AND state IN ('running','unknown')) AS uncertain`;
    return {
        guidance,
        yieldForAttachments: pending?.attachments === true,
        uncertain: receipts?.uncertain === true,
    };
}
