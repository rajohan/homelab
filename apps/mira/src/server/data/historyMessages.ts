import type { MiraMessage } from "@homelab/contracts/mira";
import type { SQL } from "bun";

import type { MiraClaim } from "./queue";

/**
 * Read indexed boundaries of message m as Unicode-safe replies with its outcome.
 * @param client - Product SQL connection; the returned fragment executes only inside its caller.
 * @returns A lateral-select fragment shared by transcript, recovery and recall reads.
 */
export function messagePartRows(client: SQL) {
    return client`SELECT p.id,p.offset,p."createdAt",
        rtrim(substring(m.content FROM p.offset+1 FOR coalesce(p."endOffset",length(m.content))-p.offset), E' \t\n\r') AS content,
        CASE WHEN p."endOffset" IS NOT NULL AND m.state IN ('streaming','completed') THEN 'completed' ELSE m.state END AS state,
        CASE WHEN p."endOffset" IS NULL THEN m.attachment_ids ELSE '[]'::jsonb END AS "attachmentIds"
        FROM (
            SELECT id,"offset",end_offset AS "endOffset",created_at::text AS "createdAt"
            FROM mira_message_replies WHERE message_id=m.id
        ) p`;
}

/**
 * Read chronological reply boundaries instead of treating a streamed row as one reply.
 * @param client - Product database connection.
 * @param run - Owned turn whose placeholder bounds the historical snapshot.
 * @param options - Bounded newest-first page and optional reply search.
 * @returns Reply excerpts with stable reply IDs for chunk retrieval and paging.
 */
export async function readHistoryMessages(
    client: SQL,
    run: MiraClaim,
    options: { limit: number; characters: number; before?: string; query?: string }
) {
    return readMessageParts(client, run.owner, run.conversationId, {
        ...options,
        snapshot: run,
    });
}

/**
 * Page indexed reply boundaries before reading and slicing message content.
 * @param client - Product database connection.
 * @param owner - Authenticated account; rows never cross account boundaries.
 * @param conversationId - Owned conversation reference.
 * @param options - Page bounds, optional excerpt limit and fixed model-history snapshot.
 * @returns Reply rows with stable part IDs and their original source message IDs.
 */
export async function readMessageParts(
    client: SQL,
    owner: string,
    conversationId: string,
    options: {
        limit: number;
        characters?: number;
        before?: string;
        after?: string;
        query?: string;
        historyOnly?: boolean;
        snapshot?: Pick<MiraClaim, "assistantMessageId" | "userMessageId">;
    }
) {
    const rows = await client<
        {
            messageId: string;
            sourceMessageId: string;
            partId: string;
            role: MiraMessage["role"];
            state: MiraMessage["state"];
            createdAt: string;
            content: string;
            attachmentIds: string[];
            truncated: boolean;
        }[]
    >`WITH page AS MATERIALIZED (
        SELECT p.* FROM mira_message_replies p JOIN mira_messages m ON m.id=p.message_id
        JOIN mira_conversations c ON c.id=p.conversation_id
        WHERE c.id=${conversationId} AND c.owner=${owner} AND c.deleted_at IS NULL
        AND (${options.historyOnly !== true} OR (c.archived_at IS NULL AND c.settings->'useHistory' IS DISTINCT FROM 'false'::jsonb AND m.state='completed'))
        AND (${options.snapshot === undefined} OR (c.archived_at IS NULL
            AND m.id<${options.snapshot?.assistantMessageId ?? null}::uuid AND m.id<>${options.snapshot?.userMessageId ?? null}::uuid
            AND m.state<>'queued' AND p.id<${options.snapshot?.assistantMessageId ?? null}::uuid
            AND NOT EXISTS (SELECT 1 FROM mira_chat_inputs i WHERE i.id=m.id AND i.state='stopped')
            AND (m.content<>'' OR jsonb_array_length(m.attachment_ids)>0)))
        AND (${options.before ?? null}::uuid IS NULL OR p.id<${options.before ?? null}::uuid)
        AND (${options.after ?? null}::uuid IS NULL OR p.id>${options.after ?? null}::uuid)
        AND (${options.query === undefined} OR to_tsvector('simple',substring(m.content FROM p.offset+1 FOR coalesce(p.end_offset,length(m.content))-p.offset)) @@ websearch_to_tsquery('simple',${options.query ?? ""}))
        ORDER BY ${options.after === undefined ? client`p.id DESC` : client`p.id ASC`} LIMIT ${options.limit}
    ) SELECT p.id AS "messageId",m.id AS "sourceMessageId",p.id AS "partId",m.role,
        CASE WHEN p.end_offset IS NOT NULL AND m.state IN ('streaming','completed') THEN 'completed' ELSE m.state END AS state,
        p.created_at::text AS "createdAt",left(reply.content,coalesce(${options.characters ?? null}::int,length(reply.content))) AS content,
        coalesce(length(reply.content)>${options.characters ?? null}::int,false) AS truncated,
        CASE WHEN p.end_offset IS NULL THEN m.attachment_ids ELSE '[]'::jsonb END AS "attachmentIds"
        FROM page p JOIN mira_messages m ON m.id=p.message_id
        CROSS JOIN LATERAL (SELECT rtrim(substring(m.content FROM p.offset+1 FOR coalesce(p.end_offset,length(m.content))-p.offset),E' \\t\\n\\r') AS content) reply
        ORDER BY ${options.after === undefined ? client`p.id DESC` : client`p.id ASC`}`;
    return rows;
}
