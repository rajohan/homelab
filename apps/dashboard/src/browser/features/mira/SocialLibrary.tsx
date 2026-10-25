import type { MiraSocialDraft } from "@homelab/contracts/miraSocial";
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
import { SocialEditor } from "./SocialEditor";
import { SocialReview } from "./SocialReview";

const tones = {
    draft: "neutral",
    queued: "neutral",
    publishing: "neutral",
    submitted: "positive",
    verification_required: "warning",
    queued_verification: "neutral",
    verifying: "neutral",
    needs_attention: "warning",
    cancelled: "neutral",
} as const;

/**
 * Show local Moltbook drafts and durable delivery outcomes alongside the conversation.
 * @returns A bounded owner-scoped library with explicit review and cancellation actions.
 */
export function SocialLibrary({
    onClose,
    conversationId,
}: {
    readonly onClose: () => void;
    readonly conversationId?: string | undefined;
}) {
    const [editing, setEditing] = useState<MiraSocialDraft | "new">();
    const [reviewing, setReviewing] = useState<MiraSocialDraft>();
    const [cancelling, setCancelling] = useState<MiraSocialDraft>();
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "social", conversationId],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.social.list.query({
                ...(conversationId ? { conversationId } : {}),
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 5000,
    });
    const cancel = useOperation((draft: MiraSocialDraft) =>
        api.mira.social.cancel.mutate({ id: draft.id, version: draft.version })
    );
    if (editing)
        return (
            <SocialEditor
                draft={editing === "new" ? undefined : editing}
                conversationId={conversationId}
                onClose={() => setEditing(undefined)}
            />
        );
    if (reviewing)
        return <SocialReview draft={reviewing} onClose={() => setReviewing(undefined)} />;
    if (cancelling)
        return (
            <ConfirmDialog
                title="Cancel submission"
                description="Cancel this draft or queued submission. Existing content on Moltbook is not deleted."
                confirmLabel="Cancel submission"
                onClose={() => setCancelling(undefined)}
                onConfirm={async () => {
                    await cancel.mutateAsync(cancelling);
                    setCancelling(undefined);
                }}
            />
        );
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    return (
        <Modal title="Moltbook drafts" onClose={onClose} size="wide">
            <div className="space-y-4">
                <SectionHeader
                    title={
                        conversationId ? "Conversation drafts" : "Drafts and submissions"
                    }
                    icon={Globe}
                    actions={
                        <Button onClick={() => setEditing("new")}>
                            <Plus size={16} aria-hidden="true" />
                            New draft
                        </Button>
                    }
                />
                {query.isPending && <LoadingState label="Loading Moltbook drafts…" />}
                {query.error && <ErrorNotice error={query.error} />}
                {!query.isPending && !query.error && rows.length === 0 && (
                    <p className="text-sm text-primary-400">
                        No Moltbook drafts yet. Create one here or ask Mira to prepare a
                        draft.
                    </p>
                )}
                {rows.map((draft) => (
                    <Card key={draft.id} className="space-y-3 bg-primary-900/40">
                        <SectionHeader
                            title={
                                draft.content.kind === "post"
                                    ? draft.content.title
                                    : "Comment or reply"
                            }
                            icon={Globe}
                            badge={
                                <Badge tone={tones[draft.state]}>
                                    {draft.state.replaceAll("_", " ")}
                                </Badge>
                            }
                            compactActions
                            actions={
                                <DropdownMenu
                                    label={`Actions for ${draft.content.kind === "post" ? draft.content.title : "Comment or reply"}`}
                                    actions={[
                                        {
                                            id: "review",
                                            label:
                                                draft.state === "draft"
                                                    ? "Review and send"
                                                    : "View submission",
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
                                        ...([
                                            "draft",
                                            "queued",
                                            "verification_required",
                                            "queued_verification",
                                        ].includes(draft.state)
                                            ? [
                                                  {
                                                      id: "cancel",
                                                      label: "Cancel submission",
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
                            {draft.agentName} · Public content
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
