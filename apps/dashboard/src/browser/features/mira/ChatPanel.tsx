import { miraDefaultChatSettings } from "@homelab/contracts/mira";
import type { MiraAttachment } from "@homelab/contracts/mira";
import {
    Card,
    ConfirmDialog,
    DropdownMenu,
    ErrorNotice,
    FieldsForm,
    IconButton,
    LoadingState,
    Modal,
} from "@homelab/ui";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
    Archive,
    Brain,
    ChevronDown,
    Files,
    MessageSquare,
    Monitor,
    PanelLeftOpen,
    Pencil,
    Settings2,
    Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { BrowserAccessPanel } from "./BrowserAccessPanel";
import { ChatComposer } from "./ChatComposer";
import { readChatDisplay, saveChatDisplay } from "./chatDisplay";
import { ChatgptConnection } from "./ChatgptConnection";
import { ChatSettings } from "./ChatSettings";
import { ChatTranscript } from "./ChatTranscript";
import { ComputerAccessDialog } from "./ComputerAccessDialog";
import { ComputerAccessPanel } from "./ComputerAccessPanel";
import { FileLibrary } from "./FileLibrary";
import { LiveChatActivity } from "./LiveChatActivity";
import { ProposedChanges } from "./ProposedChanges";
import { ProviderQuota } from "./ProviderQuota";
import { readChatUpdate } from "./readChatUpdate";
import { MiraVoiceConnection } from "./voiceConnection";

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
    readonly onLibrary: (library: "files" | "memory") => void;
    readonly onChooseConversation: () => void;
}) {
    const [text, setText] = useState("");
    const [display, setDisplay] = useState(readChatDisplay);
    const [attachments, setAttachments] = useState<MiraAttachment[]>([]);
    const [uploading, setUploading] = useState(false);
    const [selectingFile, setSelectingFile] = useState(false);
    const [dialog, setDialog] = useState<"rename" | "delete" | "settings" | "computer">();
    const request = useRef<{ text: string; id: string } | null>(null);
    const navigate = useNavigate();
    const client = useQueryClient();
    const [voice] = useState(
        () =>
            new MiraVoiceConnection(id, () => {
                void client.invalidateQueries({
                    queryKey: ["operations", "mira", "conversation", id],
                });
            })
    );
    const voiceState = useSyncExternalStore(voice.subscribe, voice.snapshot);
    const [showStatus, setShowStatus] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const queryKey = ["operations", "mira", "conversation", id];
    const query = useQuery({
        queryKey,
        queryFn: ({ signal }) =>
            readChatUpdate(id, client.getQueryData(queryKey), signal),
        refetchInterval: (current) =>
            current.state.data?.run &&
            ["queued", "running"].includes(current.state.data.run.state)
                ? 750
                : 5000,
    });
    const latest = query.data;
    const archived = Boolean(latest?.conversation.archivedAt);
    useEffect(() => {
        if (latest?.messages && !archived) voice.messages(latest.messages);
    }, [voice, latest?.messages, archived]);
    useEffect(() => {
        if (archived) return;
        voice.mount();
        return () => voice.destroy();
    }, [voice, archived]);
    const history = useInfiniteQuery({
        queryKey: ["operations", "mira", "conversation-history", id, latest?.nextCursor],
        initialPageParam: latest?.nextCursor as string | undefined,
        enabled: expanded && !!latest?.nextCursor,
        queryFn: ({ pageParam, signal }) =>
            api.mira.conversations.read.query({ id, before: pageParam }, { signal }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
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
    });
    const cancel = useOperation((runId: string) =>
        api.mira.runs.cancel.mutate({ id: runId })
    );
    const conversationVersion = latest?.conversation.version;
    const change = useOperation((action: "archive" | "restore" | "delete") => {
        if (conversationVersion === undefined)
            throw new Error("The conversation has not loaded yet.");
        return api.mira.conversations.change.mutate({
            id,
            version: conversationVersion,
            action,
        });
    });
    const rename = useOperation((title: string) => {
        if (conversationVersion === undefined)
            throw new Error("The conversation has not loaded yet.");
        return api.mira.conversations.rename.mutate({
            id,
            version: conversationVersion,
            title,
        });
    });
    const active = ["queued", "running"].includes(latest?.run?.state ?? "");
    const error = send.error ?? cancel.error ?? change.error ?? rename.error;
    if (query.isPending)
        return (
            <Card>
                <LoadingState label="Loading conversation…" />
            </Card>
        );
    if (!latest)
        return (
            <Card>
                <ErrorNotice error={query.error} />
            </Card>
        );
    const { conversation, run } = latest;
    // Older pages are prepended; the live first page wins if page boundaries overlap.
    const messages = [
        ...new Map(
            [
                ...(history.data?.pages.toReversed().flatMap((page) => page.messages) ??
                    []),
                ...latest.messages,
            ].map((message) => [message.id, message])
        ).values(),
    ];
    const modelId = active ? run?.model : conversation.settings?.model;
    const selectedModel =
        catalog.data?.models.find(
            (model) => model.model === (modelId ?? catalog.data?.defaultModel)
        ) ??
        (modelId ? undefined : catalog.data?.models.find((model) => model.isDefault));
    const waitingLabel = status.data?.online ? "Waiting" : "Offline";
    const supportsImages = Boolean(
        catalog.data?.fresh && selectedModel?.inputModalities.includes("image")
    );
    return (
        <Card className="flex min-h-0 min-w-0 flex-col overflow-y-auto rounded-none border-0 bg-primary-950 p-0 shadow-none sm:p-0">
            <header className="flex shrink-0 items-center gap-2 border-b border-primary-700 px-2 py-1 sm:px-4 sm:py-2">
                <IconButton
                    icon={PanelLeftOpen}
                    label="Choose conversation"
                    onClick={onChooseConversation}
                    className="chat-split:hidden"
                />
                <h1
                    title={conversation.title}
                    className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight text-primary-50 sm:text-lg"
                >
                    {conversation.title}
                </h1>
                <button
                    type="button"
                    aria-label={`Connection status: ${status.data?.ready ? "Ready" : waitingLabel}`}
                    aria-controls="mira-connection-details"
                    aria-expanded={showStatus}
                    onClick={() => setShowStatus(!showStatus)}
                    className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-primary-300 hover:bg-primary-800"
                >
                    <span
                        aria-hidden="true"
                        className={`size-2 rounded-full ${status.data?.ready ? "bg-emerald-400" : "bg-amber-400"}`}
                    />
                    {status.data?.ready ? "Ready" : waitingLabel}
                    <ChevronDown
                        size={14}
                        aria-hidden="true"
                        className={showStatus ? "rotate-180" : ""}
                    />
                </button>
                <DropdownMenu
                    label="Conversation actions"
                    disabled={change.isPending || rename.isPending}
                    actions={[
                        {
                            id: "settings",
                            label: "Chat settings",
                            icon: Settings2,
                            disabled: archived,
                            onSelect: () => setDialog("settings"),
                        },
                        {
                            id: "computer",
                            label: "Computer access",
                            icon: Monitor,
                            onSelect: () => setDialog("computer"),
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
                            label: conversation.archivedAt ? "Restore" : "Archive",
                            icon: Archive,
                            disabled: Boolean(active),
                            onSelect: () =>
                                change.mutate(
                                    conversation.archivedAt ? "restore" : "archive"
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
            </header>
            <div
                id="mira-connection-details"
                className="max-h-[36dvh] shrink-0 overflow-y-auto bg-primary-900"
            >
                <ChatgptConnection alertsOnly={!showStatus} />
                {showStatus && (
                    <>
                        <ProviderQuota
                            quotas={catalog.data?.quotas ?? []}
                            fresh={!catalog.isError && (catalog.data?.fresh ?? false)}
                        />
                        {(!status.data?.ready || status.data.message) && (
                            <p className="shrink-0 border-b border-primary-700 px-4 py-2 text-xs text-primary-400">
                                {status.data?.message ?? "Checking Mira connection…"}
                            </p>
                        )}
                    </>
                )}
            </div>
            {error && (
                <div className="shrink-0 px-4 py-2">
                    <ErrorNotice error={error} />
                </div>
            )}
            <ChatTranscript
                key={`transcript:${id}`}
                messages={messages}
                onReadAloud={
                    conversation.archivedAt ? undefined : (message) => voice.read(message)
                }
                readingId={voiceState.readingId}
                continuation={{
                    hasMore: history.data ? history.hasNextPage : !!latest.nextCursor,
                    loading: history.isFetching,
                    error: history.error ?? undefined,
                    onLoadMore: () => {
                        if (history.isError) void history.refetch();
                        else {
                            setExpanded(true);
                            if (history.data) void history.fetchNextPage();
                        }
                    },
                }}
                activity={
                    run ? (
                        <LiveChatActivity
                            key={`${run.id}:${display.expandTools}`}
                            run={run}
                            display={display}
                        />
                    ) : null
                }
            />
            <div className="max-h-[32dvh] shrink-0 overflow-y-auto">
                {run?.message && (
                    <p className="shrink-0 px-4 py-2 text-xs text-primary-300">
                        {run.message}
                    </p>
                )}
                <BrowserAccessPanel run={run} />
                <ComputerAccessPanel
                    run={run}
                    waiting={
                        run?.state === "running" &&
                        !run.cancelRequested &&
                        (latest.tools ?? []).some(
                            (tool) =>
                                tool.tool === "mira_computer_wait" &&
                                tool.state === "running"
                        )
                    }
                    onManage={() => setDialog("computer")}
                />
                <ProposedChanges key={`proposals:${id}`} conversationId={id} />
            </div>
            {!conversation.archivedAt && (
                <ChatComposer
                    voice={voice}
                    text={text}
                    onText={setText}
                    attachments={attachments}
                    onAttachments={setAttachments}
                    uploading={uploading}
                    onUploading={setUploading}
                    sending={send.isPending}
                    active={Boolean(active)}
                    steerable={run?.manual === true && !run.automationId}
                    stopping={run?.cancelRequested ?? false}
                    stopPending={cancel.isPending}
                    onStop={() => {
                        if (run) cancel.mutate(run.id);
                    }}
                    onSend={() => send.mutate(undefined)}
                    onBrowse={() => setSelectingFile(true)}
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
            {dialog === "computer" && (
                <ComputerAccessDialog
                    key={run?.id ?? "no-run"}
                    run={run}
                    supportsImages={supportsImages}
                    onClose={() => setDialog(undefined)}
                />
            )}
            {dialog === "settings" && (
                <ChatSettings
                    voice={voice}
                    id={id}
                    version={conversation.version}
                    settings={conversation.settings ?? miraDefaultChatSettings}
                    models={catalog.data?.models ?? []}
                    defaultModel={catalog.data?.defaultModel ?? null}
                    fresh={!catalog.isError && (catalog.data?.fresh ?? false)}
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
