import { Button, ErrorNotice } from "@homelab/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Activity, Bot, HardDrive, ListChecks } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { ChatComposer } from "./ChatComposer";
import { chatMessageSource } from "./desktopClient";
import { FileLibrary } from "./FileLibrary";
import { useChatDraft } from "./useChatDraft";

/** Start typing before a conversation exists, with an explicit path to its model, voice and attachment controls.
 * @returns A first-message composer that retains its draft and request identity after an error.
 */
export function ChatWelcome({
    connectionNotice,
}: {
    readonly connectionNotice: ReactNode;
}) {
    const field = useRef<HTMLTextAreaElement>(null);
    const client = useQueryClient();
    const [conversationId] = useState(
        () => client.getQueryData<string>(["mira-new-chat-id"]) ?? crypto.randomUUID()
    );
    useEffect(() => {
        client.setQueryData(["mira-new-chat-id"], conversationId);
    }, [client, conversationId]);
    const draft = useChatDraft(conversationId);
    const { text, setText } = draft;
    const [selectingFile, setSelectingFile] = useState(false);
    const [uploading, setUploading] = useState(false);
    const request = useRef<{ content: string; id: string } | null>(null);
    const navigate = useNavigate();
    const start = useOperation(async (action: "send" | "setup", signal) => {
        await api.mira.conversations.create.mutate(
            { title: "New conversation", id: conversationId },
            { signal }
        );
        if (action === "send") {
            const attachmentIds = draft.attachments.map((file) => file.id);
            const content = JSON.stringify([text, attachmentIds]);
            if (request.current?.content !== content)
                request.current = { content, id: crypto.randomUUID() };
            const source = await chatMessageSource(signal);
            await api.mira.conversations.send.mutate(
                {
                    ...source,
                    conversationId,
                    requestId: request.current.id,
                    text,
                    attachmentIds,
                },
                { signal }
            );
            draft.clear();
        }
        await navigate({
            to: "/mira/$conversationId",
            params: { conversationId },
            search: action === "setup" ? { settings: true } : {},
        });
        if (client.getQueryData(["mira-new-chat-id"]) === conversationId)
            client.removeQueries({ queryKey: ["mira-new-chat-id"], exact: true });
    });
    return (
        <section className="mx-auto flex w-full max-w-184 flex-1 flex-col justify-center px-4 py-8 sm:px-8">
            <div className="w-full">
                <div className="mb-6 flex flex-col items-center gap-3 text-center sm:mb-8">
                    <div className="grid size-12 place-items-center rounded-2xl border border-accent-400/20 bg-accent-400/10 text-accent-300">
                        <Bot size={26} aria-hidden="true" />
                    </div>
                    <h2 className="text-3xl font-semibold tracking-tight text-primary-50 sm:text-4xl">
                        How can Mira help?
                    </h2>
                </div>
                <ChatComposer
                    inputRef={field}
                    text={text}
                    onText={setText}
                    attachments={draft.attachments}
                    onAttachments={draft.setAttachments}
                    uploading={uploading}
                    onUploading={setUploading}
                    sending={start.isPending}
                    onBrowse={() => setSelectingFile(true)}
                    onSend={() => start.mutate("send")}
                    onSetup={() => start.mutate("setup")}
                />
                {selectingFile && (
                    <FileLibrary
                        onClose={() => setSelectingFile(false)}
                        onSelect={(file) => {
                            draft.addFile(file);
                            setSelectingFile(false);
                        }}
                    />
                )}
                {!text && (
                    <div
                        aria-label="Suggested prompts"
                        className="mt-3 flex flex-wrap justify-center gap-x-2 gap-y-1"
                    >
                        {[
                            {
                                label: "Homelab health",
                                icon: Activity,
                                prompt: "Check the health of my homelab. What needs my attention?",
                            },
                            {
                                label: "Backups",
                                icon: HardDrive,
                                prompt: "Review my recent backups and tell me which need attention.",
                            },
                            {
                                label: "My tasks",
                                icon: ListChecks,
                                prompt: "What tasks should I focus on today?",
                            },
                        ].map(({ label, icon: Icon, prompt }) => (
                            <Button
                                key={label}
                                size="sm"
                                variant="ghost"
                                disabled={start.isPending}
                                onClick={() => {
                                    setText(prompt);
                                    field.current?.focus();
                                }}
                            >
                                <Icon size={15} aria-hidden="true" />
                                {label}
                            </Button>
                        ))}
                    </div>
                )}
                {start.error && <ErrorNotice error={start.error} />}
                {connectionNotice}
            </div>
        </section>
    );
}
