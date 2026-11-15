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
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
    Archive,
    Brain,
    Cloud,
    Files,
    GitPullRequest,
    Globe,
    Mail,
    MessageSquare,
    Monitor,
    Pencil,
    Trash2,
} from "lucide-react";
import { useRef, useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { BrowserAccessDialog } from "./BrowserAccessDialog";
import { BrowserAccessPanel } from "./BrowserAccessPanel";
import { ChatActivity } from "./ChatActivity";
import { ChatComposer } from "./ChatComposer";
import { readChatDisplay, saveChatDisplay } from "./chatDisplay";
import { ChatSettings } from "./ChatSettings";
import { ChatTranscript } from "./ChatTranscript";
import { ComputerAccessDialog } from "./ComputerAccessDialog";
import { ComputerAccessPanel } from "./ComputerAccessPanel";
import { FileLibrary } from "./FileLibrary";
import { ProposedChanges } from "./ProposedChanges";
import { readChatUpdate } from "./readChatUpdate";

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
    readonly onLibrary: (
        library:
            | "files"
            | "memory"
            | "mail"
            | "publications"
            | "social"
            | "daytona"
            | "code"
    ) => void;
    readonly onChooseConversation: () => void;
}) {
    const [text, setText] = useState("");
    const [display, setDisplay] = useState(readChatDisplay);
    const [attachments, setAttachments] = useState<MiraAttachment[]>([]);
    const [uploading, setUploading] = useState(false);
    const [selectingFile, setSelectingFile] = useState(false);
    const [dialog, setDialog] = useState<
        "rename" | "delete" | "settings" | "computer" | "browser"
    >();
    const request = useRef<{ text: string; id: string } | null>(null);
    const navigate = useNavigate();
    const client = useQueryClient();
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
    const supportsImages = Boolean(
        catalog.data?.fresh && selectedModel?.inputModalities.includes("image")
    );
    return (
        <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden p-0 sm:p-0">
            <header className="shrink-0 border-b border-primary-700 px-4 py-3">
                <SectionHeader
                    title={conversation.title}
                    icon={MessageSquare}
                    badge={
                        <Badge tone={status.data?.ready ? "positive" : "warning"}>
                            {status.data?.ready ? "Ready" : "Offline"}
                        </Badge>
                    }
                    compactActions
                    actions={
                        <DropdownMenu
                            label="Conversation actions"
                            disabled={change.isPending || rename.isPending}
                            actions={[
                                {
                                    id: "browser",
                                    label: "Browser access",
                                    icon: Globe,
                                    onSelect: () => setDialog("browser"),
                                },
                                {
                                    id: "computer",
                                    label: "Computer access",
                                    icon: Monitor,
                                    onSelect: () => setDialog("computer"),
                                },
                                {
                                    id: "code",
                                    label: "Code changes",
                                    icon: GitPullRequest,
                                    onSelect: () => onLibrary("code"),
                                },
                                {
                                    id: "daytona",
                                    label: "Code jobs",
                                    icon: Cloud,
                                    onSelect: () => onLibrary("daytona"),
                                },
                                {
                                    id: "social",
                                    label: "Moltbook drafts",
                                    icon: MessageSquare,
                                    onSelect: () => onLibrary("social"),
                                },
                                {
                                    id: "publications",
                                    label: "Publications",
                                    icon: Globe,
                                    onSelect: () => onLibrary("publications"),
                                },
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
                key={id}
                messages={messages}
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
                    <ChatActivity
                        key={String(display.expandTools)}
                        run={run}
                        tools={latest.tools ?? []}
                        display={display}
                    />
                }
            />
            {run?.message && (
                <p className="shrink-0 px-4 py-2 text-xs text-primary-300">
                    {run.message}
                </p>
            )}
            <BrowserAccessPanel
                run={run}
                waiting={
                    run?.state === "running" &&
                    !run.cancelRequested &&
                    (latest.tools ?? []).some(
                        (tool) =>
                            tool.tool === "mira_browser_wait" && tool.state === "running"
                    )
                }
                onManage={() => setDialog("browser")}
            />
            <ComputerAccessPanel
                run={run}
                waiting={
                    run?.state === "running" &&
                    !run.cancelRequested &&
                    (latest.tools ?? []).some(
                        (tool) =>
                            tool.tool === "mira_computer_wait" && tool.state === "running"
                    )
                }
                onManage={() => setDialog("computer")}
            />
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
                    steerable={run?.manual === true && !run.automationId}
                    stopping={run?.cancelRequested ?? false}
                    stopPending={cancel.isPending}
                    onStop={() => {
                        if (run) cancel.mutate(run.id);
                    }}
                    onSend={() => send.mutate(undefined)}
                    onBrowse={() => setSelectingFile(true)}
                    onSettings={() => setDialog("settings")}
                    onComputer={() => setDialog("computer")}
                    onBrowser={() => setDialog("browser")}
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
            {dialog === "browser" && (
                <BrowserAccessDialog
                    key={run?.id ?? "no-run"}
                    run={run}
                    supportsImages={supportsImages}
                    onClose={() => setDialog(undefined)}
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
