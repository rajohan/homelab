import { miraDefaultChatSettings } from "@homelab/contracts/mira";
import {
    Card,
    ConfirmDialog,
    DropdownMenu,
    ErrorNotice,
    FieldsForm,
    LoadingState,
    Modal,
} from "@homelab/ui";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
    Archive,
    Brain,
    Files,
    MessageSquare,
    Monitor,
    Pencil,
    Settings2,
    SquarePen,
    Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { BrowserAccessPanel } from "./BrowserAccessPanel";
import { BrowserWorkspace } from "./BrowserWorkspace";
import { ChatComposer } from "./ChatComposer";
import { readChatDisplay, saveChatDisplay } from "./chatDisplay";
import { ChatHeader } from "./ChatHeader";
import { ChatModelControl } from "./ChatModelControl";
import { ChatSettings } from "./ChatSettings";
import { ChatTranscript } from "./ChatTranscript";
import { ComputerAccessDialog } from "./ComputerAccessDialog";
import { ComputerAccessPanel } from "./ComputerAccessPanel";
import { chatMessageSource } from "./desktopClient";
import { FileLibrary } from "./FileLibrary";
import { LiveChatActivity } from "./LiveChatActivity";
import { ProposedChanges } from "./ProposedChanges";
import { ProviderQuota } from "./ProviderQuota";
import { readChatUpdate } from "./readChatUpdate";
import { useBrowserAccess } from "./useBrowserAccess";
import { useChatDraft } from "./useChatDraft";
import { useChatModels } from "./useChatModels";
import { MiraVoiceConnection } from "./voiceConnection";
import { VoiceStatus } from "./VoiceStatus";

/**
 * Send durable messages, observe streamed text and stop or manage an owned conversation.
 * @returns A responsive chat panel with shared controls and viewport-bounded dialogs.
 */
export function ChatPanel({
    id,
    onChooseConversation,
    renderHistoryControl,
    connectionControl,
    connectionNotice,
    settingsOpen,
    onLibrary,
}: {
    readonly id: string;
    readonly settingsOpen: boolean;
    readonly renderHistoryControl: (browserOpen: boolean) => ReactNode;
    readonly connectionControl: ReactNode;
    readonly connectionNotice: ReactNode;
    readonly onLibrary: (library: "files" | "memory") => void;
    readonly onChooseConversation: () => void;
}) {
    const client = useQueryClient();
    const { text, attachments, setText, setAttachments, addFile, clear } =
        useChatDraft(id);
    const [display, setDisplay] = useState(readChatDisplay);
    const [uploading, setUploading] = useState(false);
    const [selectingFile, setSelectingFile] = useState(false);
    const [dialog, setDialog] = useState<"rename" | "delete" | "settings" | "computer">();
    const request = useRef<{ text: string; id: string } | null>(null);
    const navigate = useNavigate();
    const [voice] = useState(
        () =>
            new MiraVoiceConnection(id, () => {
                void client.invalidateQueries({
                    queryKey: ["operations", "mira", "conversation", id],
                });
            })
    );
    const voiceState = useSyncExternalStore(voice.subscribe, voice.snapshot);
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
    const browserQuery = useBrowserAccess(latest?.run ?? null);
    const [viewingBrowser, setViewingBrowser] = useState<string>();
    const browser = browserQuery.data?.[0];
    const openBrowser =
        browser?.id === viewingBrowser && browser?.state === "active"
            ? browser
            : undefined;
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
    const catalog = useChatModels();
    const send = useOperation(async (_input: undefined, signal) => {
        const contentKey = JSON.stringify({
            text,
            attachmentIds: attachments.map((file) => file.id),
        });
        if (request.current?.text !== contentKey)
            request.current = { text: contentKey, id: crypto.randomUUID() };
        const source = await chatMessageSource(signal);
        await api.mira.conversations.send.mutate(
            {
                ...source,
                conversationId: id,
                requestId: request.current.id,
                text,
                attachmentIds: attachments.map((file) => file.id),
            },
            { signal }
        );
        clear();
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
    const settings = conversation.settings ?? miraDefaultChatSettings;
    const runSettings = active && run ? run : settings;
    const modelId =
        runSettings.model ??
        catalog.data?.defaultModel ??
        catalog.data?.models.find((model) => model.isDefault)?.model ??
        null;
    const selectedModel = catalog.data?.models.find((model) => model.model === modelId);
    const fresh = !catalog.isError && !!catalog.data?.fresh;
    const supportsImages = Boolean(
        catalog.data?.fresh && selectedModel?.inputModalities.includes("image")
    );
    return (
        <>
            <section
                aria-label="Chat"
                className={`min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${openBrowser ? "chat-split:flex hidden" : "flex"}`}
            >
                <ChatHeader
                    title={conversation.title}
                    historyControl={renderHistoryControl(Boolean(openBrowser))}
                    details={
                        <>
                            <ChatModelControl
                                model={selectedModel}
                                modelId={modelId}
                                settings={runSettings}
                                active={active}
                                resolved={active && run?.settingsResolved === true}
                                archived={archived}
                                fresh={fresh}
                                loading={catalog.isPending}
                            >
                                {({ close }) => (
                                    <ChatSettings
                                        modelOnly
                                        destination={{
                                            id,
                                            version: conversation.version,
                                        }}
                                        settings={settings}
                                        models={catalog.data?.models ?? []}
                                        defaultModel={catalog.data?.defaultModel ?? null}
                                        fresh={fresh}
                                        onClose={close}
                                    />
                                )}
                            </ChatModelControl>
                            <ProviderQuota
                                quotas={catalog.data?.quotas ?? []}
                                fresh={fresh}
                            />
                        </>
                    }
                >
                    {connectionControl}
                    <DropdownMenu
                        label="Conversation actions"
                        disabled={change.isPending || rename.isPending}
                        actions={[
                            {
                                id: "new",
                                label: "New chat",
                                icon: SquarePen,
                                onSelect: () => void navigate({ to: "/mira" }),
                            },
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
                </ChatHeader>
                {connectionNotice}
                {!archived && (
                    <VoiceStatus
                        voice={voice}
                        error={voiceState.error}
                        pending={voiceState.pending}
                    />
                )}
                {error && (
                    <div className="shrink-0 px-4 py-2">
                        <ErrorNotice error={error} />
                    </div>
                )}
                <ChatTranscript
                    key={`transcript:${id}`}
                    messages={messages}
                    onReadAloud={
                        conversation.archivedAt
                            ? undefined
                            : (message) => voice.read(message)
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
                            <LiveChatActivity key={run.id} run={run} display={display} />
                        ) : null
                    }
                />
                <div className="max-h-[32dvh] shrink-0 overflow-y-auto">
                    <div hidden={Boolean(openBrowser)}>
                        <BrowserAccessPanel
                            run={run}
                            query={browserQuery}
                            onView={setViewingBrowser}
                        />
                    </div>
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
                        transcript={
                            voiceState.microphone && !voiceState.paused
                                ? voiceState.transcript
                                : ""
                        }
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
                            addFile(file);
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
                {!archived && (dialog === "settings" || settingsOpen) && (
                    <ChatSettings
                        voice={voice}
                        destination={{ id, version: conversation.version }}
                        settings={settings}
                        models={catalog.data?.models ?? []}
                        defaultModel={catalog.data?.defaultModel ?? null}
                        fresh={fresh}
                        display={display}
                        onDisplayChange={(next) => {
                            setDisplay(next);
                            saveChatDisplay(next);
                        }}
                        onClose={() => {
                            setDialog(undefined);
                            if (settingsOpen)
                                void navigate({
                                    to: "/mira/$conversationId",
                                    params: { conversationId: id },
                                    search: {},
                                    replace: true,
                                });
                        }}
                    />
                )}
                {dialog === "rename" && (
                    <Modal
                        title="Rename conversation"
                        onClose={() => setDialog(undefined)}
                    >
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
            </section>
            {openBrowser && (
                <BrowserWorkspace
                    key={openBrowser.id}
                    access={openBrowser}
                    onClose={() => setViewingBrowser(undefined)}
                />
            )}
        </>
    );
}
