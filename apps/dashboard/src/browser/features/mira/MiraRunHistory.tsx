import type { TableCursor, TableSort } from "@homelab/contracts/tableSort";
import { Button, ErrorNotice, LoadingState, SectionPanel } from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { sortedListQuery } from "../../api/sortedListQuery";
import { useOperation } from "../operations/useOperation";
import { MiraRunTable } from "./MiraRunTable";

/**
 * Reuse agent execution history in Jobs and Mira without copying run records.
 * @returns Bounded durable run outcomes, stop controls and conversation links.
 */
export function MiraRunHistory({
    title = "Mira runs",
}: { readonly title?: string } = {}) {
    const [needsReview, setNeedsReview] = useState(false);
    const [sort, setSort] = useState<TableSort | null>(null);
    const query = useInfiniteQuery({
        ...sortedListQuery(["operations", "mira", "runs", needsReview], sort),
        initialPageParam: undefined as TableCursor | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.runs.list.query({
                search: "",
                archived: false,
                needsReview,
                ...(sort ? { sort } : {}),
                ...(pageParam ? { sortCursor: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 5000,
    });
    const stop = useOperation((id: string) => api.mira.runs.cancel.mutate({ id }));
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    return (
        <SectionPanel
            title={title}
            icon={History}
            description="Agent work and outcomes across chat and automations."
            actions={
                <Button
                    size="sm"
                    variant={needsReview ? "primary" : "secondary"}
                    aria-pressed={needsReview}
                    onClick={() => setNeedsReview(!needsReview)}
                >
                    Needs review
                </Button>
            }
        >
            {query.isPending && <LoadingState label="Loading Mira runs…" />}
            {(query.error || stop.error) && (
                <ErrorNotice error={query.error ?? stop.error} />
            )}
            {rows.length > 0 && (
                <MiraRunTable
                    rows={rows}
                    sort={sort}
                    onSortChange={setSort}
                    onStop={(id) => stop.mutate(id)}
                    stoppingId={stop.isPending ? stop.variables : undefined}
                    continuation={{
                        hasMore: query.hasNextPage,
                        loading: query.isFetchingNextPage,
                        refreshing: query.isRefetching || query.isPlaceholderData,
                        error: query.isError ? query.error : undefined,
                        loadingLabel: "Loading more Mira runs…",
                        onLoadMore: () =>
                            void (query.isRefetchError
                                ? query.refetch()
                                : query.fetchNextPage()),
                    }}
                />
            )}
            {!query.isPending && !query.isError && rows.length === 0 && (
                <p className="py-1 text-sm text-primary-400">
                    {needsReview ? "No runs need review." : "No Mira runs yet."}
                </p>
            )}
        </SectionPanel>
    );
}
