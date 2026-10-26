import type { MiraCodePublication } from "@homelab/contracts/miraCode";
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
import { Eye, GitPullRequest, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { CodeEditor } from "./CodeEditor";
import { CodeReview } from "./CodeReview";

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
export function CodeLibrary({
    onClose,
    conversationId,
}: {
    readonly onClose?: (() => void) | undefined;
    readonly conversationId?: string | undefined;
}) {
    const [editing, setEditing] = useState<MiraCodePublication | "new">();
    const [reviewing, setReviewing] = useState<MiraCodePublication>();
    const [cancelling, setCancelling] = useState<MiraCodePublication>();
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "code", conversationId],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.code.list.query({
                ...(conversationId ? { conversationId } : {}),
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 5000,
    });
    const cancel = useOperation((draft: MiraCodePublication) =>
        api.mira.code.cancel.mutate({ id: draft.id, version: draft.version })
    );
    if (editing)
        return (
            <CodeEditor
                draft={editing === "new" ? undefined : editing}
                conversationId={conversationId}
                onClose={() => setEditing(undefined)}
            />
        );
    if (reviewing)
        return <CodeReview draft={reviewing} onClose={() => setReviewing(undefined)} />;
    if (cancelling)
        return (
            <ConfirmDialog
                title="Cancel proposal"
                description="Cancel this draft or queued proposal. An attempted publication can only be inspected."
                confirmLabel="Cancel proposal"
                onClose={() => setCancelling(undefined)}
                onConfirm={async () => {
                    await cancel.mutateAsync(cancelling);
                    setCancelling(undefined);
                }}
            />
        );
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    const content = (
        <div className="space-y-4">
            <SectionHeader
                title={conversationId ? "Conversation proposals" : "Code changes"}
                icon={GitPullRequest}
                actions={
                    <Button onClick={() => setEditing("new")}>
                        <Plus size={16} aria-hidden="true" />
                        New proposal
                    </Button>
                }
            />
            {query.isPending && <LoadingState label="Loading code proposals…" />}
            {query.error && <ErrorNotice error={query.error} />}
            {!query.isPending && !query.error && rows.length === 0 && (
                <p className="text-sm text-primary-400">
                    No code proposals yet. Complete a structured-edit check, then create a
                    proposal here or ask Mira to prepare one.
                </p>
            )}
            <div className="max-h-128 space-y-3 overflow-y-auto">
                {rows.map((draft) => (
                    <Card key={draft.id} className="space-y-3 bg-primary-900/40">
                        <SectionHeader
                            title={draft.content.title}
                            icon={GitPullRequest}
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
                                                    ? "Review and create PR"
                                                    : "View proposal",
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
                                                      label: "Cancel proposal",
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
                            Base {draft.content.commit.slice(0, 12)} · rajohan/homelab
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
            </div>
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
    );
    return onClose ? (
        <Modal title="Code changes" onClose={onClose} size="wide">
            {content}
        </Modal>
    ) : (
        <Card>{content}</Card>
    );
}
