import type { SQL } from "bun";

import { auditMira } from "../data/context";
import type { CodexRuntime } from "../runtime/codexRuntime";

/**
 * Retry provider-history cleanup after product content is deleted, without raw database edits.
 * @param client - Dedicated executor pool.
 * @param runtime - Fresh connection that has not loaded any conversation.
 * @returns Number of deletion receipts committed; failures leave the reference pending.
 */
export async function cleanupMiraConversations(
    client: SQL,
    runtime: Pick<CodexRuntime, "deleteThread">
): Promise<number> {
    const rows = await client<
        { id: string; owner: string; providerThread: string }[]
    >`SELECT id, owner, provider_thread AS "providerThread" FROM mira_conversations c WHERE deleted_at IS NOT NULL AND provider_thread IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mira_runs r WHERE r.conversation_id = c.id AND r.state IN ('queued','running')) ORDER BY deleted_at LIMIT 1`;
    for (const row of rows) {
        await runtime.deleteThread(row.providerThread);
        await client.begin(async (query) => {
            const updated = await query<
                { id: string }[]
            >`UPDATE mira_conversations SET provider_thread = NULL WHERE id = ${row.id} AND deleted_at IS NOT NULL AND provider_thread = ${row.providerThread} RETURNING id`;
            if (updated.length > 0)
                await auditMira(
                    query,
                    { owner: row.owner, actor: "mira:cleanup" },
                    "conversation.provider_deleted",
                    row.id
                );
        });
    }
    return rows.length;
}
