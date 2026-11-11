import type { MiraMessage } from "@homelab/contracts/mira";
import { Button } from "@homelab/ui";
import { ArrowDown } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

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
    const content = useRef<HTMLDivElement>(null);
    const following = useRef(!before);
    const [showJump, setShowJump] = useState(Boolean(before));
    const scrollToBottom = () => {
        const node = viewport.current;
        if (!node) return;
        following.current = true;
        node.scrollTop = node.scrollHeight;
        setShowJump(false);
    };
    useLayoutEffect(() => {
        if (following.current && viewport.current)
            viewport.current.scrollTop = viewport.current.scrollHeight;
    }, [messages, activity]);
    useLayoutEffect(() => {
        const node = viewport.current;
        const body = content.current;
        if (!node || !body) return;
        // Streaming text, images and viewport resizing can change the height
        // independently of message arrival. Only follow an already-following reader.
        const resize = new ResizeObserver(() => {
            if (following.current) node.scrollTop = node.scrollHeight;
        });
        resize.observe(node);
        resize.observe(body);
        return () => resize.disconnect();
    }, []);
    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            <div
                ref={viewport}
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [overflow-anchor:none]"
                role="log"
                aria-label="Conversation messages"
                aria-live="polite"
                aria-relevant="additions text"
                onScroll={(event) => {
                    const node = event.currentTarget;
                    following.current =
                        !before &&
                        node.scrollHeight - node.clientHeight - node.scrollTop < 80;
                    setShowJump(!following.current);
                }}
            >
                <div ref={content} className="space-y-5 p-4 sm:p-5">
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
            </div>
            {showJump && (
                <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                    <Button
                        className="pointer-events-auto shadow-lg"
                        variant="secondary"
                        size="sm"
                        onClick={() => (before ? onPage(undefined) : scrollToBottom())}
                    >
                        <ArrowDown size={16} aria-hidden="true" />
                        Back to bottom
                    </Button>
                </div>
            )}
        </div>
    );
}
