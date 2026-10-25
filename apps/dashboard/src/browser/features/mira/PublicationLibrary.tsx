import type { MiraPublication } from "@homelab/contracts/miraPublication";
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
import { Eye, Globe, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { PublicationEditor } from "./PublicationEditor";
import { PublicationReview } from "./PublicationReview";

const tones = {
    draft: "neutral",
    queued: "neutral",
    publishing: "neutral",
    published: "positive",
    needs_attention: "warning",
    cancelled: "neutral",
} as const;

/**
 * Show local publication drafts and durable delivery outcomes alongside the conversation.
 * @returns A bounded owner-scoped library with explicit review and cancellation actions.
 */
export function PublicationLibrary({
    onClose,
    conversationId,
}: {
    readonly onClose: () => void;
    readonly conversationId?: string | undefined;
}) {
    const [editing, setEditing] = useState<MiraPublication | "new">();
    const [reviewing, setReviewing] = useState<MiraPublication>();
    const [cancelling, setCancelling] = useState<MiraPublication>();
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "publications", conversationId],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.publications.list.query({
                ...(conversationId ? { conversationId } : {}),
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 5000,
    });
    const cancel = useOperation((draft: MiraPublication) =>
        api.mira.publications.cancel.mutate({ id: draft.id, version: draft.version })
    );
    if (editing)
        return (
            <PublicationEditor
                draft={editing === "new" ? undefined : editing}
                conversationId={conversationId}
                onClose={() => setEditing(undefined)}
            />
        );
    if (reviewing)
        return (
            <PublicationReview
                draft={reviewing}
                onClose={() => setReviewing(undefined)}
            />
        );
    if (cancelling)
        return (
            <ConfirmDialog
                title="Cancel publication"
                description="Cancel this draft or queued publication. Publication already in progress must be reviewed in here.now."
                confirmLabel="Cancel publication"
                onClose={() => setCancelling(undefined)}
                onConfirm={async () => {
                    await cancel.mutateAsync(cancelling);
                    setCancelling(undefined);
                }}
            />
        );
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    return (
        <Modal title="Publications" onClose={onClose} size="wide">
            <div className="space-y-4">
                <SectionHeader
                    title={
                        conversationId ? "Conversation drafts" : "Drafts and publications"
                    }
                    icon={Globe}
                    actions={
                        <Button onClick={() => setEditing("new")}>
                            <Plus size={16} aria-hidden="true" />
                            New draft
                        </Button>
                    }
                />
                {query.isPending && <LoadingState label="Loading publication drafts…" />}
                {query.error && <ErrorNotice error={query.error} />}
                {!query.isPending && !query.error && rows.length === 0 && (
                    <p className="text-sm text-primary-400">
                        No publication drafts yet. Create one here or ask Mira to prepare
                        a draft.
                    </p>
                )}
                {rows.map((draft) => (
                    <Card key={draft.id} className="space-y-3 bg-primary-900/40">
                        <SectionHeader
                            title={draft.content.title}
                            icon={Globe}
                            badge={
                                <Badge tone={tones[draft.state]}>
                                    {draft.state.replaceAll("_", " ")}
                                </Badge>
                            }
                            compactActions
                            actions={
                                <DropdownMenu
                                    label={`Actions for ${draft.content.title}`}
                                    actions={[
                                        {
                                            id: "review",
                                            label:
                                                draft.state === "draft"
                                                    ? "Review and publish"
                                                    : "View publication",
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
                                                      label: "Cancel publication",
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
                            {draft.content.files.length} files · Anyone with the link
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
