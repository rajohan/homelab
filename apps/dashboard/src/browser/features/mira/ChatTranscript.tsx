import type { MiraMessage } from "@homelab/contracts/mira";
import {
    Button,
    type InfiniteScrollContinuation,
    InfiniteScrollTrigger,
} from "@homelab/ui";
import { ArrowDown } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { ChatMessage } from "./ChatMessage";

/**
 * Keep the transcript inside the workspace and follow new replies without moving a reader in history.
 * @returns A bounded, accessible message log with automatic history loading.
 */
export function ChatTranscript({
    messages,
    continuation,
    activity,
}: {
    readonly activity?: ReactNode;
    readonly messages: MiraMessage[];
    readonly continuation: InfiniteScrollContinuation;
}) {
    const viewport = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    const [showJump, setShowJump] = useState(false);
    const anchor = useRef<{
        element: HTMLElement;
        top: number;
        first: string | undefined;
    } | null>(null);
    const loadOlder = () => {
        const node = viewport.current;
        const element = content.current?.querySelector<HTMLElement>("[data-message-id]");
        if (!following.current && node && element)
            anchor.current = {
                element,
                top: element.getBoundingClientRect().top + node.scrollTop,
                first: messages[0]?.id,
            };
        continuation.onLoadMore();
    };
    const scrollToBottom = () => {
        const node = viewport.current;
        if (!node) return;
        following.current = true;
        anchor.current = null;
        node.scrollTop = node.scrollHeight;
        setShowJump(false);
    };
    useLayoutEffect(() => {
        const saved = anchor.current;
        const node = viewport.current;
        if (!node) return;
        if (following.current) node.scrollTop = node.scrollHeight;
        else if (saved && saved.first !== messages[0]?.id) {
            node.scrollTop +=
                saved.element.getBoundingClientRect().top + node.scrollTop - saved.top;
            anchor.current = null;
        }
        if (!continuation.loading) anchor.current = null;
    }, [messages, activity, continuation.loading]);
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
                        node.scrollHeight - node.clientHeight - node.scrollTop < 80;
                    setShowJump(!following.current);
                }}
            >
                <div ref={content} className="space-y-5 p-4 sm:p-5">
                    <InfiniteScrollTrigger
                        {...continuation}
                        rootRef={viewport}
                        itemCount={messages.length}
                        loadingLabel="Loading earlier messages..."
                        onLoadMore={loadOlder}
                    />
                    {messages.length === 0 && (
                        <p className="py-12 text-center text-sm text-primary-400">
                            Start a conversation with Mira.
                        </p>
                    )}
                    {messages.filter((message) => message.role === "user" || message.content.trim() || message.attachmentIds.length > 0).map((message) => (
                        <div key={message.id} data-message-id={message.id}>
                            <ChatMessage message={message} />
                        </div>
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
                        onClick={scrollToBottom}
                    >
                        <ArrowDown size={16} aria-hidden="true" />
                        Back to bottom
                    </Button>
                </div>
            )}
        </div>
    );
}
