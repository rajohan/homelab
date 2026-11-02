import type { MiraMessage } from "@homelab/contracts/mira";
import { Button } from "@homelab/ui";
import { useEffect, useRef, type ReactNode } from "react";

import { ChatMessage } from "./ChatMessage";

/**
 * Keep the transcript inside the workspace and follow new replies without moving a reader in history.
 * @returns A bounded, accessible message log with explicit history navigation.
 */
export function ChatTranscript({
    messages,
    before,
    nextCursor,
    onPage,
    activity,
}: {
    readonly activity?: ReactNode;
    readonly messages: MiraMessage[];
    readonly before: string | undefined;
    readonly nextCursor: string | null;
    readonly onPage: (cursor: string | undefined) => void;
}) {
    const viewport = useRef<HTMLDivElement>(null);
    const following = useRef(!before);
    useEffect(() => {
        const node = viewport.current;
        if (!node) return;
        if (following.current) node.scrollTop = node.scrollHeight;
    }, [messages]);
    return (
        <div
            ref={viewport}
            className="min-h-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto overscroll-contain p-4 sm:p-5"
            role="log"
            aria-label="Conversation messages"
            aria-live="polite"
            aria-relevant="additions text"
            onScroll={(event) => {
                const node = event.currentTarget;
                following.current =
                    node.scrollHeight - node.clientHeight - node.scrollTop < 80;
            }}
        >
            {(nextCursor || before) && (
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
                    {nextCursor && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onPage(nextCursor)}
                        >
                            Older messages
                        </Button>
                    )}
                    {before && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onPage(undefined)}
                        >
                            Latest messages
                        </Button>
                    )}
                </div>
            )}
            {messages.length === 0 && (
                <p className="py-12 text-center text-sm text-primary-400">
                    Start a conversation with Mira.
                </p>
            )}
            {messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
            ))}
            {activity}
        </div>
    );
}
