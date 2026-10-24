import { miraDefaultChatSettings } from "@homelab/contracts/mira";
import type { MiraAttachment } from "@homelab/contracts/mira";
import {
    Badge,
    Card,
    ConfirmDialog,
    DropdownMenu,
    ErrorNotice,
    FieldsForm,
    LoadingState,
    Modal,
    SectionHeader,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Archive, Brain, Files, Mail, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { ChatActivity } from "./ChatActivity";
import { ChatComposer } from "./ChatComposer";
import { readChatDisplay, saveChatDisplay } from "./chatDisplay";
import { ChatSettings } from "./ChatSettings";
import { ChatTranscript } from "./ChatTranscript";
import { FileLibrary } from "./FileLibrary";
import { ProposedChanges } from "./ProposedChanges";

/**
 * Send durable messages, observe streamed text and stop or manage an owned conversation.
 * @returns A responsive chat panel with shared controls and viewport-bounded dialogs.
 */
export function ChatPanel({
    id,
    onChooseConversation,
    onLibrary,
}: {
    readonly id: string;
    readonly onLibrary: (library: "files" | "memory" | "mail") => void;
    readonly onChooseConversation: () => void;
}) {
    const [text, setText] = useState("");
    const [display, setDisplay] = useState(readChatDisplay);
    const [attachments, setAttachments] = useState<MiraAttachment[]>([]);
    const [uploading, setUploading] = useState(false);
    const [selectingFile, setSelectingFile] = useState(false);
    const [dialog, setDialog] = useState<"rename" | "delete" | "settings">();
    const [before, setBefore] = useState<string>();
    const request = useRef<{ text: string; id: string } | null>(null);
    const navigate = useNavigate();
    const query = useQuery({
        queryKey: ["operations", "mira", "conversation", id, before],
        queryFn: ({ signal }) =>
            api.mira.conversations.read.query(
                { id, ...(before ? { before } : {}) },
                { signal }
            ),
        refetchInterval: (current) =>
            current.state.data?.run &&
            ["queued", "running"].includes(current.state.data.run.state)
                ? 750
                : 5000,
    });
    const status = useQuery({
        queryKey: ["operations", "mira", "status"],
        queryFn: () => api.mira.status.query(),
        refetchInterval: 15_000,
    });
    const catalog = useQuery({
        queryKey: ["operations", "mira", "models"],
        queryFn: () => api.mira.models.query(),
        refetchInterval: 30_000,
    });
    const send = useOperation(async () => {
        const contentKey = JSON.stringify({
            text,
            attachmentIds: attachments.map((file) => file.id),
        });
        if (request.current?.text !== contentKey)
            request.current = { text: contentKey, id: crypto.randomUUID() };
        await api.mira.conversations.send.mutate({
            conversationId: id,
            requestId: request.current.id,
            text,
            attachmentIds: attachments.map((file) => file.id),
        });
        setText("");
        setAttachments([]);
        request.current = null;
        setBefore(undefined);
    });
    const cancel = useOperation((runId: string) =>
        api.mira.runs.cancel.mutate({ id: runId })
    );
    const change = useOperation((action: "archive" | "restore" | "delete") =>
        api.mira.conversations.change.mutate({
            id,
            version: query.data!.conversation.version,
            action,
        })
    );
    const rename = useOperation((title: string) =>
        api.mira.conversations.rename.mutate({
            id,
            version: query.data!.conversation.version,
            title,
        })
    );
    const active =
        query.data?.run && ["queued", "running"].includes(query.data.run.state);
    const error = send.error ?? cancel.error ?? change.error ?? rename.error;
    if (query.isPending)
        return (
            <Card>
                <LoadingState label="Loading conversation…" />
            </Card>
        );
    if (!query.data)
        return (
            <Card>
                <ErrorNotice error={query.error} />
            </Card>
        );
    const { conversation, messages, run } = query.data;
    return (
        <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden p-0 sm:p-0">
            <header className="shrink-0 border-b border-primary-700 px-4 py-3">
                <SectionHeader
                    title={conversation.title}
                    icon={MessageSquare}
                    badge={<Badge>{status.data?.ready ? "Ready" : "Offline"}</Badge>}
                    compactActions
                    actions={
                        <DropdownMenu
                            label="Conversation actions"
                            disabled={change.isPending || rename.isPending}
                            actions={[
                                {
                                    id: "mail",
                                    label: "Email drafts",
                                    icon: Mail,
                                    onSelect: () => onLibrary("mail"),
                                },
                                {
                                    id: "files",
                                    label: "Files",
                                    icon: Files,
                                    onSelect: () => onLibrary("files"),
                                },
                                {
                                    id: "memory",
                                    label: "Memory",
                                    icon: Brain,
                                    onSelect: () => onLibrary("memory"),
                                },
                                {
                                    id: "conversations",
                                    label: "Conversations",
                                    icon: MessageSquare,
                                    onSelect: onChooseConversation,
                                },
                                {
                                    id: "rename",
                                    label: "Rename",
                                    icon: Pencil,
                                    onSelect: () => setDialog("rename"),
                                },
                                {
                                    id: "archive",
                                    label: conversation.archivedAt
                                        ? "Restore"
                                        : "Archive",
                                    icon: Archive,
                                    disabled: Boolean(active),
                                    onSelect: () =>
                                        change.mutate(
                                            conversation.archivedAt
                                                ? "restore"
                                                : "archive"
                                        ),
                                },
                                {
                                    id: "delete",
                                    label: "Delete conversation",
                                    icon: Trash2,
                                    danger: true,
                                    disabled: Boolean(active),
                                    onSelect: () => setDialog("delete"),
                                },
                            ]}
                        />
                    }
                />
            </header>
            {(!status.data?.ready || status.data.message) && (
                <p className="shrink-0 border-b border-primary-700 px-4 py-2 text-xs text-primary-400">
                    {status.data?.message ?? "Checking Mira connection…"}
                </p>
            )}
            {error && (
                <div className="shrink-0 px-4 py-2">
                    <ErrorNotice error={error} />
                </div>
            )}
            <ProposedChanges conversationId={id} />
            <ChatTranscript
                key={before ?? "latest"}
                messages={messages}
                before={before}
                nextCursor={query.data.nextCursor}
                onPage={setBefore}
                activity={
                    !before && (
                        <ChatActivity
                            key={String(display.expandTools)}
                            run={run}
                            tools={query.data.tools ?? []}
                            display={display}
                        />
                    )
                }
            />
            {run?.message && (
                <p className="shrink-0 px-4 py-2 text-xs text-primary-300">
                    {run.message}
                </p>
            )}
            {!conversation.archivedAt && (
                <ChatComposer
                    text={text}
                    onText={setText}
                    attachments={attachments}
                    onAttachments={setAttachments}
                    uploading={uploading}
                    onUploading={setUploading}
                    sending={send.isPending}
                    active={Boolean(active)}
                    stopping={run?.cancelRequested ?? false}
                    stopPending={cancel.isPending}
                    onStop={() => {
                        if (run) cancel.mutate(run.id);
                    }}
                    onSend={() => send.mutate(undefined)}
                    onBrowse={() => setSelectingFile(true)}
                    onSettings={() => setDialog("settings")}
                />
            )}
            {selectingFile && (
                <FileLibrary
                    onClose={() => setSelectingFile(false)}
                    onSelect={(file) => {
                        setAttachments((current) =>
                            current.some((entry) => entry.id === file.id) ||
                            current.length >= 8
                                ? current
                                : [...current, file]
                        );
                        setSelectingFile(false);
                    }}
                />
            )}
            {dialog === "settings" && (
                <ChatSettings
                    id={id}
                    version={conversation.version}
                    settings={conversation.settings ?? miraDefaultChatSettings}
                    models={catalog.data?.models ?? []}
                    defaultModel={catalog.data?.defaultModel ?? null}
                    fresh={catalog.data?.fresh ?? false}
                    display={display}
                    onDisplayChange={(next) => {
                        setDisplay(next);
                        saveChatDisplay(next);
                    }}
                    onClose={() => setDialog(undefined)}
                />
            )}
            {dialog === "rename" && (
                <Modal title="Rename conversation" onClose={() => setDialog(undefined)}>
                    <FieldsForm
                        fields={[
                            {
                                name: "title",
                                label: "Title",
                                initial: conversation.title,
                                maximum: 160,
                            },
                        ]}
                        submitLabel="Save"
                        onCancel={() => setDialog(undefined)}
                        onSubmit={async (values) => {
                            await rename.mutateAsync(values.title ?? "");
                            setDialog(undefined);
                        }}
                    />
                </Modal>
            )}
            {dialog === "delete" && (
                <ConfirmDialog
                    title="Delete conversation"
                    description="Remove this conversation and its messages. Execution audit records are retained."
                    confirmLabel="Delete conversation"
                    onClose={() => setDialog(undefined)}
                    onConfirm={async () => {
                        await change.mutateAsync("delete");
                        await navigate({ to: "/mira" });
                    }}
                />
            )}
        </Card>
    );
}
