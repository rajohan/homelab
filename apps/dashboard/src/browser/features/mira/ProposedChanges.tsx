import type { MiraActionCursor } from "@homelab/contracts/mira";
import { Button, ErrorNotice, IconButton, Modal } from "@homelab/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { ActionReview } from "./ActionReview";
import { ProposalReview } from "./ProposalReview";
import { QuestionReview } from "./QuestionReview";

/**
 * Keep durable requests accessible without covering the conversation.
 * @returns Compact request navigation, collapsible questions and explicit approval dialogs.
 */
export function ProposedChanges({
    conversationId,
}: {
    readonly conversationId?: string;
}) {
    const [selected, setSelected] = useState<string>();
    const [minimized, setMinimized] = useState(false);
    const query = useQuery({
        queryKey: ["operations", "mira", "proposals", conversationId],
        queryFn: async () =>
            conversationId
                ? await api.mira.proposals.list.query({ id: conversationId })
                : [],
        refetchInterval: 1500,
    });
    const actions = useInfiniteQuery({
        queryKey: ["operations", "mira", "action-requests", conversationId],
        queryFn: async ({ pageParam, signal }) => {
            let before = pageParam;
            // Covered drafts may fill a page; keep looking for a real human request.
            while (true) {
                const page = await api.mira.proposals.actions.query(
                    {
                        ...(conversationId ? { id: conversationId } : {}),
                        ...(before ? { before } : {}),
                    },
                    { signal }
                );
                if (page.rows.length > 0 || !page.nextCursor) return page;
                before = page.nextCursor;
            }
        },
        initialPageParam: undefined as MiraActionCursor | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 5000,
    });
    const requests = [
        ...(query.data ?? []).map((proposal) => ({
            kind: "proposal" as const,
            id: proposal.id,
            proposal,
        })),
        ...new Map(
            (actions.data?.pages.flatMap((page) => page.rows) ?? [])
                .filter((action) => action.state === "draft")
                .map((action) => [
                    `${action.kind}:${action.id}`,
                    {
                        kind: "action" as const,
                        id: `${action.kind}:${action.id}`,
                        action,
                    },
                ])
        ).values(),
    ];
    const [review, setReview] = useState<(typeof requests)[number]>();
    const index = Math.max(
        0,
        requests.findIndex((request) => request.id === selected)
    );
    const current = requests[index];
    const question =
        current?.kind === "proposal" &&
        current.proposal.tool === "mira_request_user_input";
    let requestTitle = "Approval needed";
    if (question) requestTitle = "Your input is needed";

    if (requests.length === 0 && !query.error && !actions.error && !review) return null;
    return (
        <section
            aria-label="Requests from Mira"
            className="flex max-h-[40%] min-h-0 shrink flex-col border-t border-primary-700 bg-primary-900/40"
        >
            {query.error && <ErrorNotice error={query.error} />}
            {actions.error && <ErrorNotice error={actions.error} />}
            {current && (
                <>
                    <div className="flex min-w-0 shrink-0 items-center justify-between gap-2 px-3 py-1.5">
                        <p
                            className="min-w-0 truncate text-xs font-medium text-primary-100"
                            aria-live="polite"
                        >
                            {requestTitle}
                        </p>
                        <div className="flex shrink-0 items-center gap-1">
                            {(requests.length > 1 || actions.hasNextPage) && (
                                <>
                                    <IconButton
                                        icon={ChevronLeft}
                                        label="Previous request"
                                        disabled={index === 0}
                                        onClick={() =>
                                            setSelected(requests[index - 1]?.id)
                                        }
                                    />
                                    <span
                                        className="text-xs text-primary-400"
                                        aria-live="polite"
                                    >
                                        {index + 1} of {requests.length}
                                    </span>
                                    <IconButton
                                        icon={ChevronRight}
                                        label="Next request"
                                        disabled={
                                            actions.isFetchingNextPage ||
                                            (index === requests.length - 1 &&
                                                !actions.hasNextPage)
                                        }
                                        onClick={() => {
                                            const next = requests[index + 1];
                                            if (next) setSelected(next.id);
                                            else
                                                void actions
                                                    .fetchNextPage()
                                                    .then((result) => {
                                                        const known = new Set(
                                                            requests.map(
                                                                (request) => request.id
                                                            )
                                                        );
                                                        const first = result.data?.pages
                                                            .at(-1)
                                                            ?.rows.find(
                                                                (row) =>
                                                                    !known.has(
                                                                        `${row.kind}:${row.id}`
                                                                    )
                                                            );
                                                        if (first)
                                                            return setSelected(
                                                                `${first.kind}:${first.id}`
                                                            );
                                                        return;
                                                    });
                                        }}
                                    />
                                </>
                            )}
                            {question ? (
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    aria-expanded={!minimized}
                                    onClick={() => setMinimized(!minimized)}
                                >
                                    {minimized ? "Show question" : "Minimize"}
                                </Button>
                            ) : (
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => setReview(current)}
                                >
                                    Review approval
                                </Button>
                            )}
                        </div>
                    </div>
                    <div
                        hidden={!question || minimized}
                        className="max-h-[min(20rem,35dvh)] min-h-0 overflow-y-auto overscroll-contain px-3 pb-2"
                    >
                        {requests
                            .filter(
                                (request) =>
                                    request.kind === "proposal" &&
                                    request.proposal.tool === "mira_request_user_input"
                            )
                            .map((request) => (
                                <div key={request.id} hidden={request.id !== current.id}>
                                    {request.kind === "proposal" && (
                                        <QuestionReview proposal={request.proposal} />
                                    )}
                                </div>
                            ))}
                    </div>
                </>
            )}
            {review?.kind === "proposal" && (
                <Modal
                    title="Review proposed change"
                    onClose={() => setReview(undefined)}
                >
                    <ProposalReview
                        proposal={review.proposal}
                        onClose={() => {
                            setReview(undefined);
                            void query.refetch();
                        }}
                    />
                </Modal>
            )}
            {review?.kind === "action" && (
                <ActionReview
                    action={review.action}
                    onClose={() => {
                        setReview(undefined);
                        void actions.refetch();
                    }}
                />
            )}
        </section>
    );
}
