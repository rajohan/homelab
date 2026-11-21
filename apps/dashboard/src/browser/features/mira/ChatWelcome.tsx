import { Button, ErrorNotice } from "@homelab/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, MessageCircle, SlidersHorizontal } from "lucide-react";
import { useRef, useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { ChatgptConnection } from "./ChatgptConnection";
import { MessageField } from "./MessageField";

/** Start typing before a conversation exists, with an explicit path to its model, voice and attachment controls.
 * @returns A first-message composer that retains its draft and request identity after an error.
 */
export function ChatWelcome() {
    const [text, setText] = useState("");
    const [conversationId] = useState(() => crypto.randomUUID());
    const request = useRef<{ text: string; id: string } | null>(null);
    const client = useQueryClient();
    const navigate = useNavigate();
    const start = useOperation(async (action: "send" | "setup", signal) => {
        await api.mira.conversations.create.mutate(
            { title: "New conversation", id: conversationId },
            { signal }
        );
        if (action === "send") {
            if (request.current?.text !== text)
                request.current = { text, id: crypto.randomUUID() };
            await api.mira.conversations.send.mutate(
                {
                    conversationId,
                    requestId: request.current.id,
                    text,
                    attachmentIds: [],
                },
                { signal }
            );
        } else if (text) client.setQueryData(["mira-draft", conversationId], text);
        await navigate({ to: "/mira/$conversationId", params: { conversationId } });
    });
    const canSend = Boolean(text.trim()) && !start.isPending;
    return (
        <section className="chat-split:col-start-2 chat-split:row-start-1 flex min-h-0 min-w-0 flex-col bg-transparent">
            <div className="chat-split:py-10 mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-5 sm:px-8">
                <div className="mb-4 flex items-center gap-3">
                    <MessageCircle
                        size={25}
                        className="text-workspace-accent shrink-0"
                        aria-hidden="true"
                    />
                    <h2 className="text-2xl font-semibold tracking-tight text-primary-50 sm:text-3xl">
                        Message Mira
                    </h2>
                </div>
                <form
                    className="rounded-xl border border-primary-600 bg-surface-card p-2 focus-within:border-accent-400 sm:p-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (canSend) start.mutate("send");
                    }}
                >
                    <MessageField
                        value={text}
                        onChange={setText}
                        canSend={canSend}
                        disabled={start.isPending}
                        rows={3}
                    />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <Button
                            size="sm"
                            variant="secondary"
                            busy={start.isPending && start.variables === "setup"}
                            disabled={start.isPending}
                            onClick={() => start.mutate("setup")}
                        >
                            <SlidersHorizontal size={16} aria-hidden="true" />
                            Chat tools
                        </Button>
                        <Button
                            type="submit"
                            busy={start.isPending && start.variables === "send"}
                            disabled={!canSend}
                        >
                            <ArrowUp size={16} aria-hidden="true" />
                            Send
                        </Button>
                    </div>
                </form>
                {start.error && <ErrorNotice error={start.error} />}
                <div className="mt-3">
                    <ChatgptConnection />
                </div>
            </div>
        </section>
    );
}
