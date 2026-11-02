import type { MiraMessage } from "@homelab/contracts/mira";

/**
 * Expand persisted provider replies into separately timestamped bubbles.
 * @param messages - Conversation rows, including legacy replies without boundaries.
 * @returns Chronological bubbles; files and the active state belong to the latest reply.
 */
export function chatMessageParts(messages: readonly MiraMessage[]): MiraMessage[] {
    return messages
        .flatMap((message) => {
            const parts = message.role === "assistant" ? message.parts : undefined;
            if (!parts?.length) return [message];
            return parts.map((part, index) => ({
                ...message,
                id: part.id,
                content: message.content
                    .slice(part.offset, parts[index + 1]?.offset)
                    .trimEnd(),
                createdAt: part.createdAt,
                state:
                    index === parts.length - 1 ? message.state : ("completed" as const),
                attachmentIds: index === parts.length - 1 ? message.attachmentIds : [],
            }));
        })
        .toSorted((a, b) => a.id.localeCompare(b.id));
}
