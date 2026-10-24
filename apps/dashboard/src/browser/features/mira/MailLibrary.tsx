import type { MiraMailDraft } from "@homelab/contracts/miraMail";
import {
    Badge,
    Button,
    Card,
    ConfirmDialog,
    DropdownMenu,
    ErrorNotice,
    LoadingState,
    Modal,
    SectionHeader,
    formatDateTime,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Eye, Mail, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { MailEditor } from "./MailEditor";
import { MailReview } from "./MailReview";

const tones = {
    draft: "neutral",
    queued: "neutral",
    sending: "neutral",
    sent: "positive",
    needs_attention: "warning",
    cancelled: "neutral",
} as const;

/**
 * Show local email drafts and durable delivery outcomes alongside the conversation.
 * @returns A bounded owner-scoped library with explicit review and cancellation actions.
 */
export function MailLibrary({
    onClose,
    conversationId,
}: {
    readonly onClose: () => void;
    readonly conversationId?: string | undefined;
}) {
    const [editing, setEditing] = useState<MiraMailDraft | "new">();
    const [reviewing, setReviewing] = useState<MiraMailDraft>();
    const [cancelling, setCancelling] = useState<MiraMailDraft>();
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "mail", conversationId],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.mail.list.query({
                ...(conversationId ? { conversationId } : {}),
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 5000,
    });
    const cancel = useOperation((draft: MiraMailDraft) =>
        api.mira.mail.cancel.mutate({ id: draft.id, version: draft.version })
    );
    if (editing)
        return (
            <MailEditor
                draft={editing === "new" ? undefined : editing}
                conversationId={conversationId}
                onClose={() => setEditing(undefined)}
            />
        );
    if (reviewing)
        return <MailReview draft={reviewing} onClose={() => setReviewing(undefined)} />;
    if (cancelling)
        return (
            <ConfirmDialog
                title="Cancel email"
                description="Cancel this draft or queued delivery. A message already being sent cannot be recalled."
                confirmLabel="Cancel email"
                onClose={() => setCancelling(undefined)}
                onConfirm={async () => {
                    await cancel.mutateAsync(cancelling);
                    setCancelling(undefined);
                }}
            />
        );
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    return (
        <Modal title="Email drafts" onClose={onClose} size="wide">
            <div className="space-y-4">
                <SectionHeader
                    title={conversationId ? "Conversation drafts" : "Drafts and delivery"}
                    icon={Mail}
                    actions={
                        <Button onClick={() => setEditing("new")}>
                            <Plus size={16} aria-hidden="true" />
                            New draft
                        </Button>
                    }
                />
                {query.isPending && <LoadingState label="Loading email drafts…" />}
                {query.error && <ErrorNotice error={query.error} />}
                {!query.isPending && !query.error && rows.length === 0 && (
                    <p className="text-sm text-primary-400">
                        No email drafts yet. Create one here or ask Mira to prepare a
                        draft.
                    </p>
                )}
                {rows.map((draft) => (
                    <Card key={draft.id} className="space-y-3 bg-primary-900/40">
                        <SectionHeader
                            title={draft.content.subject}
                            icon={Mail}
                            badge={
                                <Badge tone={tones[draft.state]}>
                                    {draft.state.replaceAll("_", " ")}
                                </Badge>
                            }
                            compactActions
                            actions={
                                <DropdownMenu
                                    label={`Actions for ${draft.content.subject}`}
                                    actions={[
                                        {
                                            id: "review",
                                            label:
                                                draft.state === "draft"
                                                    ? "Review and send"
                                                    : "View email",
                                            icon: Eye,
                                            onSelect: () => setReviewing(draft),
                                        },
                                        ...(draft.state === "draft"
                                            ? [
                                                  {
                                                      id: "edit",
                                                      label: "Edit",
                                                      icon: Pencil,
                                                      onSelect: () => setEditing(draft),
                                                  },
                                              ]
                                            : []),
                                        ...(["draft", "queued"].includes(draft.state)
                                            ? [
                                                  {
                                                      id: "cancel",
                                                      label: "Cancel email",
                                                      icon: Trash2,
                                                      danger: true,
                                                      onSelect: () =>
                                                          setCancelling(draft),
                                                  },
                                              ]
                                            : []),
                                    ]}
                                />
                            }
                        />
                        <p className="truncate text-sm text-primary-300">
                            To: {draft.content.to.join(", ")}
                        </p>
                        {draft.message && (
                            <p className="text-sm text-primary-300">{draft.message}</p>
                        )}
                        <time
                            className="text-xs text-primary-400"
                            dateTime={draft.updatedAt}
                        >
                            {formatDateTime(draft.updatedAt)}
                        </time>
                    </Card>
                ))}
                {query.hasNextPage && (
                    <Button
                        variant="secondary"
                        fullWidth
                        busy={query.isFetchingNextPage}
                        onClick={() => void query.fetchNextPage()}
                    >
                        Load more
                    </Button>
                )}
            </div>
        </Modal>
    );
}
