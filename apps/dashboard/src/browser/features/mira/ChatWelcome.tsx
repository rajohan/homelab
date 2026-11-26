import { miraDefaultChatSettings } from "@homelab/contracts/mira";
import { ErrorNotice } from "@homelab/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { ChatComposer } from "./ChatComposer";
import { chatMessageSource } from "./desktopClient";
import { DraftChatSettings } from "./DraftChatSettings";
import { FileLibrary } from "./FileLibrary";
import { useChatDraft } from "./useChatDraft";

/** Start typing before a conversation exists, with an explicit path to its model, voice and attachment controls.
 * @returns A first-message composer that retains its draft and request identity after an error.
 */
export function ChatWelcome() {
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
    const [showSettings, setShowSettings] = useState(false);
    const navigate = useNavigate();
    const start = useOperation(async (_input: undefined, signal) => {
        const source = await chatMessageSource(signal);
        await api.mira.conversations.send.mutate(
            {
                ...source,
                conversationId,
                requestId: conversationId,
                text,
                attachmentIds: draft.attachments.map((file) => file.id),
                initialSettings: draft.settings ?? miraDefaultChatSettings,
            },
            { signal }
        );
        draft.clear();
        await navigate({
            to: "/mira/$conversationId",
            params: { conversationId },
            search: {},
        });
        if (client.getQueryData(["mira-new-chat-id"]) === conversationId)
            client.removeQueries({ queryKey: ["mira-new-chat-id"], exact: true });
    });
    return (
        <section className="chat-column my-auto shrink-0 py-5 sm:py-8 [@media(max-height:28rem)]:py-1">
            <div className="w-full">
                <div className="mb-6 flex flex-col items-center gap-3 text-center sm:mb-8 [@media(max-height:20rem)]:sr-only [@media(max-height:28rem)]:mb-2">
                    <div className="grid size-12 place-items-center rounded-2xl border border-accent-400/20 bg-accent-400/10 text-accent-300 [@media(max-height:28rem)]:hidden">
                        <Bot size={26} aria-hidden="true" />
                    </div>
                    <h2 className="text-3xl font-semibold tracking-tight text-primary-50 sm:text-4xl">
                        How can Mira help?
                    </h2>
                </div>
                <ChatComposer
                    text={text}
                    onText={setText}
                    attachments={draft.attachments}
                    onAttachments={draft.setAttachments}
                    uploading={uploading}
                    onUploading={setUploading}
                    sending={start.isPending}
                    onBrowse={() => setSelectingFile(true)}
                    onSend={() => start.mutate(undefined)}
                    onSetup={() => setShowSettings(true)}
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
                {showSettings && (
                    <DraftChatSettings
                        id={conversationId}
                        settings={draft.settings ?? miraDefaultChatSettings}
                        onSave={draft.setSettings}
                        onClose={() => setShowSettings(false)}
                    />
                )}
                {start.error && <ErrorNotice error={start.error} />}
            </div>
        </section>
    );
}
