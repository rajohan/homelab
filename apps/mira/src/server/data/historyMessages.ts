import type { MiraMessage } from "@homelab/contracts/mira";
import type { SQL } from "bun";

import type { MiraClaim } from "./queue";

/**
 * Expand the message aliased as m into Unicode-safe replies with their parent outcome.
 * @param client - Product SQL connection; the returned fragment executes only inside its caller.
 * @returns A lateral-select fragment shared by transcript, recovery and recall reads.
 */
export function messagePartRows(client: SQL) {
    return client`SELECT p.id,p.offset,p."createdAt",
        rtrim(substring(m.content FROM p.offset+1 FOR coalesce(p."endOffset",length(m.content))-p.offset), E' \t\n\r') AS content,
        CASE WHEN p."endOffset" IS NOT NULL AND m.state IN ('streaming','completed') THEN 'completed' ELSE m.state END AS state,
        CASE WHEN p."endOffset" IS NULL THEN m.attachment_ids ELSE '[]'::jsonb END AS "attachmentIds"
        FROM (
            SELECT (value->>'id')::uuid AS id,(value->>'offset')::int AS offset,
                value->>'createdAt' AS "createdAt",
                lead((value->>'offset')::int) OVER (ORDER BY ordinality) AS "endOffset"
            FROM jsonb_array_elements(CASE WHEN m.role='assistant' AND jsonb_array_length(m.parts)>0
                THEN m.parts ELSE jsonb_build_array(jsonb_build_object('id',m.id,'offset',0,'createdAt',m.created_at)) END) WITH ORDINALITY
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
 * Expand persisted replies before ordering and pagination for clients and model history.
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
    >`SELECT p.id AS "messageId",m.id AS "sourceMessageId",p.id AS "partId",m.role,p.state,
        p."createdAt",left(p.content,coalesce(${options.characters ?? null}::int,length(p.content))) AS content,
        coalesce(length(p.content)>${options.characters ?? null}::int,false) AS truncated,p."attachmentIds"
        FROM mira_messages m JOIN mira_conversations c ON c.id=m.conversation_id
        CROSS JOIN LATERAL (${messagePartRows(client)}) p
        WHERE c.id=${conversationId} AND c.owner=${owner} AND c.deleted_at IS NULL
        AND (${options.historyOnly !== true} OR (c.archived_at IS NULL AND c.settings->'useHistory' IS DISTINCT FROM 'false'::jsonb AND m.state='completed'))
        AND (${options.snapshot === undefined} OR (c.archived_at IS NULL
            AND m.id<${options.snapshot?.assistantMessageId ?? null}::uuid AND m.id<>${options.snapshot?.userMessageId ?? null}::uuid
            AND m.state<>'queued' AND p.id<${options.snapshot?.assistantMessageId ?? null}::uuid
            AND NOT EXISTS (SELECT 1 FROM mira_chat_inputs i WHERE i.id=m.id AND i.state='stopped')
            AND (m.content<>'' OR jsonb_array_length(m.attachment_ids)>0)))
        AND (${options.before ?? null}::uuid IS NULL OR p.id<${options.before ?? null}::uuid)
        AND (${options.after ?? null}::uuid IS NULL OR p.id>${options.after ?? null}::uuid)
        AND (${options.query === undefined} OR to_tsvector('simple',p.content) @@ websearch_to_tsquery('simple',${options.query ?? ""}))
        ORDER BY CASE WHEN ${options.after !== undefined} THEN p.id END ASC,p.id DESC LIMIT ${options.limit}`;
    return rows;
}
