import type { MiraMessage } from "@homelab/contracts/mira";
import { Badge, CopyTextButton, formatDateTime, IconButton, Markdown } from "@homelab/ui";
import { Bot, Square, Volume2 } from "lucide-react";

import { MessageAttachments } from "./MessageAttachments";
import { miraStatusTone } from "./statusTone";

/** Present the operator's messages and Mira's replies with their original text and state.
 * @returns A transcript entry with message-specific actions.
 */
export function ChatMessage({
    message,
    onReadAloud,
    reading = false,
}: {
    readonly message: MiraMessage;
    readonly onReadAloud?: ((message: MiraMessage) => void) | undefined;
    readonly reading?: boolean;
}) {
    const user = message.role === "user";
    if (!user && !message.content.trim() && message.attachmentIds.length === 0)
        return null;
    return (
        <article
            aria-label={user ? "Your message" : "Mira message"}
            className={`flex min-w-0 flex-col ${user ? "items-end" : "items-start"}`}
        >
            {!user && (
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary-100">
                    <Bot size={18} className="text-accent-300" aria-hidden="true" />
                    Mira
                </div>
            )}
            <div
                className={`min-w-0 text-primary-100 [&_.prose]:text-base [&_.prose]:leading-relaxed ${user ? "max-w-[90%] rounded-2xl rounded-br-md bg-surface-card px-4 py-2.5 sm:max-w-[84%]" : "w-full"}`}
            >
                {message.content && <Markdown>{message.content}</Markdown>}
                {message.attachmentIds.length > 0 && (
                    <MessageAttachments ids={message.attachmentIds} />
                )}
            </div>
            <div className="mt-1 flex max-w-full flex-wrap items-center gap-x-1.5 text-xs text-primary-400">
                <time
                    dateTime={message.createdAt}
                    title={formatDateTime(message.createdAt)}
                >
                    {formatDateTime(message.createdAt)}
                </time>
                {["failed", "interrupted"].includes(message.state) && (
                    <Badge tone={miraStatusTone(message.state)}>
                        {message.state.replaceAll("_", " ")}
                    </Badge>
                )}
                {!user && message.content && message.state === "completed" && (
                    <>
                        <CopyTextButton
                            iconOnly
                            text={message.content}
                            label="Copy reply"
                        />
                        {onReadAloud && (
                            <IconButton
                                icon={reading ? Square : Volume2}
                                label={
                                    reading ? "Stop reading this message" : "Read aloud"
                                }
                                onClick={() => onReadAloud(message)}
                            />
                        )}
                    </>
                )}
            </div>
        </article>
    );
}
