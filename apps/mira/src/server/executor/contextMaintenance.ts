import type { SQL } from "bun";

import type { MiraClaim } from "../data/queue";
import type { CodexRuntime } from "../runtime/codexRuntime";
import type { RuntimeTool } from "../runtime/protocol";
import {
    rolloutContextBatches,
    visualContextBytes,
    visualContextImages,
} from "../runtime/rolloutContext";
import type { RuntimeToolResult } from "../runtime/toolResult";

/**
 * Replace oversized visual history through native compaction without replacing the product chat.
 * @param options - Fenced run, idle runtime and current trusted tool/policy registry.
 * @returns The committed provider reference; failed candidates remain queued for cleanup.
 */
export async function maintainMiraContext(options: {
    client: SQL;
    run: MiraClaim;
    runtime: Pick<
        CodexRuntime,
        "readContext" | "startThread" | "compactThread" | "importContext" | "retireThread"
    >;
    threadId: string;
    model: string;
    workspace: string;
    tools: RuntimeTool<RuntimeToolResult>[];
    instructions: string;
    signal: AbortSignal;
    expireImages?: boolean;
}): Promise<string> {
    const { client, run, runtime, threadId, signal } = options;
    let source = await runtime.readContext(threadId);
    if (!source) return threadId;
    if (
        source.images < visualContextImages &&
        source.imageBytes < visualContextBytes &&
        source.size < 2 * visualContextBytes &&
        !(source.images > 0 && options.expireImages)
    )
        return threadId;
    signal.throwIfAborted();
    // The normal path summarizes pixels before expiry. Already broken, oversized legacy
    // requests retain their previous native checkpoint and all subsequent textual context.
    if (source.imageBytes <= 2 * visualContextBytes) {
        const checkpoint = source.checkpointOffset;
        await runtime.compactThread(threadId, signal);
        source = await runtime.readContext(threadId);
        if (!source || source.checkpointOffset <= checkpoint)
            throw new Error("Compacted provider context was not durably recorded.");
    }
    const replacement = await runtime.startThread(
        options.model,
        options.workspace,
        options.tools,
        options.instructions
    );
    const tracked = await client<
        { id: string }[]
    >`UPDATE mira_conversations SET provider_retired_threads=provider_retired_threads || ${JSON.stringify([replacement])}::text::jsonb WHERE id=${run.conversationId} AND owner=${run.owner} RETURNING id`;
    if (tracked.length !== 1) {
        await runtime.retireThread(replacement);
        throw new Error("Context maintenance lost its conversation lease.");
    }
    const [permitted] = await client<
        { id: string }[]
    >`SELECT c.id FROM mira_conversations c WHERE id=${run.conversationId} AND owner=${run.owner} AND provider_thread=${threadId} AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM mira_runs WHERE id=${run.id} AND state='running' AND NOT cancel_requested AND lease_token=${run.leaseToken} AND lease_expires_at>clock_timestamp())`;
    if (!permitted) throw new Error("Context maintenance lost its conversation lease.");
    let replacementCheckpoint = 0;
    for await (const batch of rolloutContextBatches(source, true)) {
        signal.throwIfAborted();
        await runtime.importContext(replacement, batch);
        await runtime.compactThread(replacement, signal);
        const checkpoint = await runtime.readContext(replacement);
        if (
            !checkpoint ||
            checkpoint.checkpointOffset <= replacementCheckpoint ||
            checkpoint.images !== 0
        )
            throw new Error(
                "Replacement context was not durably compacted without historical images."
            );
        replacementCheckpoint = checkpoint.checkpointOffset;
    }
    signal.throwIfAborted();
    if (replacementCheckpoint === 0)
        throw new Error(
            "Replacement context was not compacted without historical images."
        );
    const promoted = await client<
        { id: string }[]
    >`UPDATE mira_conversations c SET provider_thread=${replacement},provider_retired_threads=(provider_retired_threads - ${replacement}) || ${JSON.stringify([threadId])}::text::jsonb WHERE id=${run.conversationId} AND owner=${run.owner} AND provider_thread=${threadId} AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM mira_runs WHERE id=${run.id} AND state='running' AND NOT cancel_requested AND lease_token=${run.leaseToken} AND lease_expires_at>clock_timestamp()) RETURNING id`;
    if (promoted.length !== 1)
        throw new Error("Context replacement lost its conversation lease.");
    try {
        await runtime.retireThread(threadId);
        await client`UPDATE mira_conversations SET provider_retired_threads=provider_retired_threads - ${threadId} WHERE id=${run.conversationId} AND owner=${run.owner} AND provider_thread<>${threadId}`;
    } catch {
        // Cleanup is retried from the durable queue; a confirmed replacement stays usable.
    }
    return replacement;
}
