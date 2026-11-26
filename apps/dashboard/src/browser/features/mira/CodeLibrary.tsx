import type { MiraCodePublication } from "@homelab/contracts/miraCode";
import {
    Badge,
    Card,
    ConfirmDialog,
    DropdownMenu,
    formatDateTime,
    InfiniteScrollTrigger,
    LoadingState,
    Modal,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Eye, GitPullRequest, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { CodeReview } from "./CodeReview";
import { miraStatusTone } from "./statusTone";

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
    const scrollRoot = useRef<HTMLDivElement>(null);
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
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    const content = (
        <div className="space-y-4">
            <SectionHeader
                title={conversationId ? "Conversation proposals" : "Code changes"}
                icon={GitPullRequest}
            />
            {query.isPending && <LoadingState label="Loading code proposals…" />}
            {!query.isPending && !query.error && rows.length === 0 && (
                <p className="text-sm text-primary-400">
                    No code proposals yet. Complete a structured-edit check, then create a
                    proposal by asking Mira in Chat.
                </p>
            )}
            <div
                ref={scrollRoot}
                className="max-h-128 scroll-frame divide-y divide-primary-700 bg-surface-card"
            >
                {rows.map((draft) => (
                    <section key={draft.id} className="space-y-3 p-4 sm:p-5">
                        <SectionHeader
                            title={draft.content.title}
                            icon={GitPullRequest}
                            badge={
                                <Badge tone={miraStatusTone(draft.state)}>
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
                    </section>
                ))}
                <InfiniteScrollTrigger
                    rootRef={scrollRoot}
                    itemCount={query.data?.pages.length ?? 0}
                    hasMore={query.hasNextPage}
                    loading={query.isFetchingNextPage}
                    refreshing={query.isRefetching}
                    error={query.isError ? query.error : undefined}
                    onLoadMore={() =>
                        void (query.isRefetchError
                            ? query.refetch()
                            : query.fetchNextPage())
                    }
                />
            </div>
            {reviewing && (
                <CodeReview draft={reviewing} onClose={() => setReviewing(undefined)} />
            )}
            {cancelling && (
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
