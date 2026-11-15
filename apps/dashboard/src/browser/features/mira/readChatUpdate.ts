import { api } from "../../api/client";

type ConversationPage = Awaited<ReturnType<typeof api.mira.conversations.read.query>>;

/**
 * Refresh live activity without repolling history or dropping replies received while disconnected.
 * @param id - Current owned conversation.
 * @param previous - Previously observed live replies and their original history boundary.
 * @param signal - Query cancellation, including navigation away from the conversation.
 * @param read - Conversation transport; replaceable for reconnect regression tests.
 * @returns Current activity with a continuous, deduplicated live transcript.
 */
export async function readChatUpdate(
    id: string,
    previous: ConversationPage | undefined,
    signal: AbortSignal,
    read: (
        input: { id: string; before?: string },
        options: { signal: AbortSignal }
    ) => Promise<ConversationPage> = api.mira.conversations.read.query
): Promise<ConversationPage> {
    const latest = await read({ id }, { signal });
    if (!previous) return latest;
    const last = previous.messages.at(-1)?.id;
    const messages = new Map(previous.messages.map((message) => [message.id, message]));
    let page = latest;
    while (true) {
        signal.throwIfAborted();
        for (const message of page.messages) messages.set(message.id, message);
        if (
            !page.nextCursor ||
            (last && page.messages.some((message) => message.id <= last))
        )
            break;
        page = await read({ id, before: page.nextCursor }, { signal });
    }
    return {
        ...latest,
        messages: [...messages.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
        nextCursor: previous.nextCursor,
    };
}
