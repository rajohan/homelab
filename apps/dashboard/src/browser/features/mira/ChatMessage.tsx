import type { MiraMessage } from "@homelab/contracts/mira";
import { Badge, formatDateTime, IconButton, Markdown } from "@homelab/ui";
import { AudioLines, Square, Volume2 } from "lucide-react";

import { MessageAttachments } from "./MessageAttachments";
import { miraStatusTone } from "./statusTone";

/**
 * Show a persisted message, including partial text and its actual terminal state.
 * @returns A readable chat entry that does not conceal interrupted or failed output.
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
            aria-label={`${user ? "You" : "Mira"} message`}
            className={`flex min-w-0 ${user ? "justify-end" : "justify-start"}`}
        >
            <div
                className={`min-w-0 ${user ? "max-w-[92%] rounded-2xl rounded-br-md bg-primary-800 px-4 py-3 text-primary-100 sm:max-w-[82%]" : "w-full text-primary-100"}`}
            >
                <div
                    className={`mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold ${user ? "text-primary-300" : "text-primary-400"}`}
                >
                    <span
                        className={
                            user
                                ? "text-primary-300"
                                : "inline-flex items-center gap-2 text-sm font-semibold text-primary-50"
                        }
                    >
                        {!user && (
                            <AudioLines
                                aria-hidden="true"
                                size={18}
                                className="text-accent-300"
                            />
                        )}
                        {user ? "You" : "Mira"}
                    </span>
                    <time
                        dateTime={message.createdAt}
                        className="font-normal tabular-nums"
                    >
                        {formatDateTime(message.createdAt)}
                    </time>
                    {["failed", "interrupted"].includes(message.state) && (
                        <Badge tone={miraStatusTone(message.state)}>
                            {message.state.replaceAll("_", " ")}
                        </Badge>
                    )}
                    {!user &&
                        message.content &&
                        message.state === "completed" &&
                        onReadAloud && (
                            <IconButton
                                icon={reading ? Square : Volume2}
                                label={
                                    reading ? "Stop reading this message" : "Read aloud"
                                }
                                className="ml-auto"
                                onClick={() => onReadAloud(message)}
                            />
                        )}
                </div>
                <div className="[&_.prose]:text-base [&_.prose]:leading-relaxed">
                    {message.content ? <Markdown>{message.content}</Markdown> : null}
                </div>
                {message.attachmentIds.length > 0 && (
                    <MessageAttachments ids={message.attachmentIds} />
                )}
            </div>
        </article>
    );
}
