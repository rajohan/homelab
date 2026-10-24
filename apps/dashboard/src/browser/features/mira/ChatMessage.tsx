import type { MiraMessage } from "@homelab/contracts/mira";
import { Badge, Markdown, formatDateTime } from "@homelab/ui";

import { MessageAttachments } from "./MessageAttachments";

/**
 * Show a persisted message, including partial text and its actual terminal state.
 * @returns A readable chat entry that does not conceal interrupted or failed output.
 */
export function ChatMessage({ message }: { readonly message: MiraMessage }) {
    const pendingText =
        message.state === "queued" ? "Waiting for Mira…" : "Mira is working…";
    const user = message.role === "user";
    return (
        <article
            aria-label={`${user ? "You" : "Mira"} message`}
            className={`flex min-w-0 ${user ? "justify-end" : "justify-start"}`}
        >
            <div
                className={`max-w-[94%] min-w-0 rounded-2xl px-4 py-3 sm:max-w-[88%] ${user ? "bg-accent-700 text-white" : "bg-primary-950 text-primary-100"}`}
            >
                <div
                    className={`mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold ${user ? "text-white/80" : "text-primary-400"}`}
                >
                    <span>{message.role === "user" ? "You" : "Mira"}</span>
                    <time
                        dateTime={message.createdAt}
                        className="ml-auto font-normal tabular-nums"
                    >
                        {formatDateTime(message.createdAt)}
                    </time>
                    {message.state !== "completed" && (
                        <Badge>
                            {message.state === "streaming"
                                ? "Replying"
                                : message.state.replaceAll("_", " ")}
                        </Badge>
                    )}
                </div>
                {message.content ? (
                    <Markdown tone={user ? "onAccent" : "default"}>
                        {message.content}
                    </Markdown>
                ) : (
                    <p className="text-sm text-primary-400">
                        {["queued", "streaming"].includes(message.state)
                            ? pendingText
                            : "No reply was recorded."}
                    </p>
                )}
                {message.attachmentIds.length > 0 && (
                    <MessageAttachments ids={message.attachmentIds} />
                )}
            </div>
        </article>
    );
}
