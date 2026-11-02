import type { SQL } from "bun";

import type { MiraClaim } from "./queue";

/**
 * Read chronological reply boundaries instead of treating a streamed row as one reply.
 * @param client - Product database connection.
 * @param run - Owned turn whose placeholder bounds the historical snapshot.
 * @param options - Bounded newest-first page and optional reply search.
 * @returns Reply excerpts with the original message ID for chunk retrieval and part IDs for paging.
 */
export async function readHistoryMessages(
    client: SQL,
    run: MiraClaim,
    options: { limit: number; characters: number; before?: string; query?: string }
) {
    const rows = await client<
        {
            messageId: string;
            partId: string;
            role: string;
            state: string;
            createdAt: string;
            content: string;
            attachmentIds: string[];
            truncated: boolean;
        }[]
    >`SELECT m.id AS "messageId",p.id AS "partId",m.role,
        CASE WHEN p."endOffset" IS NULL THEN m.state ELSE 'completed' END AS state,
        p."createdAt",left(reply.content,${options.characters}) AS content,length(reply.content)>${options.characters} AS truncated,
        CASE WHEN p."endOffset" IS NULL THEN m.attachment_ids ELSE '[]'::jsonb END AS "attachmentIds"
        FROM mira_messages m JOIN mira_conversations c ON c.id=m.conversation_id
        CROSS JOIN LATERAL (
            SELECT (value->>'id')::uuid AS id,(value->>'offset')::int AS offset,
                value->>'createdAt' AS "createdAt",
                lead((value->>'offset')::int) OVER (ORDER BY ordinality) AS "endOffset"
            FROM jsonb_array_elements(CASE WHEN m.role='assistant' AND jsonb_array_length(m.parts)>0
                THEN m.parts ELSE jsonb_build_array(jsonb_build_object('id',m.id,'offset',0,'createdAt',m.created_at)) END) WITH ORDINALITY
        ) p
        CROSS JOIN LATERAL (SELECT rtrim(substring(m.content FROM p.offset+1 FOR coalesce(p."endOffset",length(m.content))-p.offset), E' \t\n\r') AS content) reply
        WHERE c.id=${run.conversationId} AND c.owner=${run.owner} AND c.deleted_at IS NULL AND c.archived_at IS NULL
        AND m.id<${run.assistantMessageId} AND m.id<>${run.userMessageId}
        AND m.state<>'queued' AND p.id<${run.assistantMessageId} AND p.id<${options.before ?? run.assistantMessageId}
        AND (m.content<>'' OR jsonb_array_length(m.attachment_ids)>0)
        AND (${options.query === undefined} OR to_tsvector('simple',reply.content) @@ websearch_to_tsquery('simple',${options.query ?? ""}))
        ORDER BY p.id DESC LIMIT ${options.limit}`;
    return rows;
}
