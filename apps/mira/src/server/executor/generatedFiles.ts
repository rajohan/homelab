import type { SQL } from "bun";
import * as v from "valibot";

import { auditMira, MiraFailure, type MiraContext } from "../data/context";
import { miraFileType, saveMiraFile } from "../data/files";
import type { MiraClaim } from "../data/queue";

const maximumBytes = 1024 * 1024;
function requireSignal(signal: AbortSignal): void {
    if (signal.aborted)
        throw new MiraFailure(
            "CONFLICT",
            "This run was cancelled before the file was accepted."
        );
}
const inputSchema = v.strictObject({
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
    content: v.pipe(v.string(), v.minLength(1), v.maxLength(maximumBytes)),
});

/**
 * Save one generated UTF-8 artifact on the current owned assistant message.
 * @param client - Product database; readiness and message linking commit together.
 * @param run - Service-selected leased run, never selected by tool arguments.
 * @param directory - Private file volume shared with normal downloads and draft selection.
 * @param input - Display filename and bounded UTF-8 text, never an executable path.
 * @param signal - Run cancellation, checked before reservation and at the readiness boundary.
 * @returns Attachment metadata; exact retries in this run reuse the same immutable file.
 */
export async function saveGeneratedMiraFile(
    client: SQL,
    run: MiraClaim,
    directory: string | undefined,
    input: unknown,
    signal: AbortSignal
) {
    requireSignal(signal);
    if (!directory || run.automationId)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Generated files require a manual run and configured file storage."
        );
    const parsed = v.parse(inputSchema, input);
    if (!parsed.name.isWellFormed() || !parsed.content.isWellFormed())
        throw new MiraFailure(
            "BAD_REQUEST",
            "Use valid Unicode text in the filename and content; unpaired surrogate characters cannot be saved exactly."
        );
    const bytes = new TextEncoder().encode(parsed.content);
    if (
        bytes.length > maximumBytes ||
        miraFileType(bytes) !== "text/plain; charset=utf-8"
    )
        throw new MiraFailure(
            "BAD_REQUEST",
            "Generate UTF-8 text files up to 1 MiB. Binary file generation is not available."
        );
    const digest = new Bun.CryptoHasher("sha256")
        .update(
            JSON.stringify([
                "mira:generated-file:v1",
                run.id,
                parsed.name,
                new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
            ])
        )
        .digest();
    digest[6] = (digest[6]! & 15) | 128;
    digest[8] = (digest[8]! & 63) | 128;
    const hex = Buffer.from(digest.subarray(0, 16)).toString("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const available = await client<
        { id: string }[]
    >`SELECT r.id FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id JOIN mira_messages m ON m.id=r.assistant_message_id AND m.conversation_id=c.id WHERE r.id=${run.id} AND r.owner=${run.owner} AND c.owner=${run.owner} AND c.deleted_at IS NULL AND r.conversation_id=${run.conversationId} AND r.assistant_message_id=${run.assistantMessageId} AND r.state='running' AND NOT r.cancel_requested AND r.lease_token=${run.leaseToken} AND r.lease_expires_at>clock_timestamp() AND (jsonb_array_length(m.attachment_ids)<8 OR m.attachment_ids @> ${JSON.stringify([id])}::text::jsonb)`;
    if (!available[0])
        throw new MiraFailure(
            "CONFLICT",
            "This run is unavailable or its response already contains eight files."
        );
    const context: MiraContext = {
        client,
        owner: run.owner,
        actor: `mira:${run.id}`,
        run: { id: run.id, leaseToken: run.leaseToken },
    };
    requireSignal(signal);
    const file = await saveMiraFile(
        context,
        directory,
        { id, name: parsed.name, bytes },
        async (query) => {
            requireSignal(signal);
            await auditMira(query, context, "file.generated", id);
            const linked = await query<
                { id: string }[]
            >`UPDATE mira_messages m SET attachment_ids=CASE WHEN attachment_ids @> ${JSON.stringify([id])}::text::jsonb THEN attachment_ids ELSE attachment_ids || ${JSON.stringify([id])}::text::jsonb END WHERE m.id=${run.assistantMessageId} AND m.conversation_id=${run.conversationId} AND (jsonb_array_length(attachment_ids)<8 OR attachment_ids @> ${JSON.stringify([id])}::text::jsonb) AND EXISTS(SELECT 1 FROM mira_conversations c WHERE c.id=m.conversation_id AND c.owner=${run.owner} AND c.deleted_at IS NULL) RETURNING m.id`;
            if (!linked[0])
                throw new MiraFailure(
                    "CONFLICT",
                    "This conversation is unavailable or the response already contains eight files."
                );
        }
    );
    return {
        file,
        message:
            "Created in this conversation. The file is not executed, emailed or published.",
    };
}
