import type { TableSort } from "@homelab/contracts/tableSort";
import {
    Card,
    EmptyState,
    ErrorNotice,
    LoadingState,
    queryRefresh,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { History, ListTodo } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { sortedListQuery } from "../../api/sortedListQuery";
import { JobRunTable } from "./JobRunTable";
import { RunDetailDialog } from "./RunDetailDialog";

/**
 * Reuse independently paginated run views for the queue, recent history and one job.
 * @returns A bounded history view with filters applied on the server before pagination.
 */
export function JobHistory({
    action,
    view = "recent",
    title = "Recent run history",
    embedded = false,
}: {
    readonly action?: string;
    readonly view?: "all" | "active" | "recent";
    readonly title?: string;
    readonly embedded?: boolean;
}) {
    const [selected, setSelected] = useState<string>();
    const [sort, setSort] = useState<TableSort | null>(null);
    const query = useInfiniteQuery({
        ...sortedListQuery(["operations", "jobs", "history", action, view], sort),
        initialPageParam: {},
        queryFn: ({ pageParam, signal }) =>
            api.jobs.list.query(
                {
                    ...pageParam,
                    ...(sort ? { sort } : {}),
                    ...(action ? { action } : {}),
                    view,
                },
                { signal }
            ),
        getNextPageParam: (page) => {
            if (sort)
                return page.nextSortCursor ? { cursor: page.nextSortCursor } : undefined;
            return page.nextCursor ? { before: page.nextCursor } : undefined;
        },
        ...queryRefresh("fast"),
        retry: false,
    });
    const rows = query.data?.pages.flatMap((page) => page.runs) ?? [];
    const Container = embedded ? "section" : Card;
    return (
        <Container className="space-y-4">
            {!embedded && (
                <SectionHeader
                    title={title}
                    description={
                        view === "active"
                            ? "Queued and running jobs, including pending retries."
                            : "Inspect attempts, outcomes and the event history of each run."
                    }
                    icon={view === "active" ? ListTodo : History}
                />
            )}
            <div
                className={
                    view === "active"
                        ? "grid h-(--queue-height) grid-rows-[minmax(0,1fr)] [--queue-height:clamp(10rem,26dvh,15rem)] [&>p]:content-center [&>p]:overflow-y-auto"
                        : "space-y-4"
                }
            >
                {query.isPending && <LoadingState label="Loading jobs…" />}
                {query.isError && rows.length === 0 && (
                    <ErrorNotice error={query.error} />
                )}
                {rows.length > 0 && (
                    <JobRunTable
                        {...(view === "active"
                            ? { className: "h-(--queue-height) max-h-none" }
                            : {})}
                        rows={rows}
                        sort={sort}
                        onSortChange={setSort}
                        onSelect={setSelected}
                        continuation={{
                            hasMore: query.hasNextPage,
                            loading: query.isFetchingNextPage,
                            refreshing: query.isRefetching || query.isPlaceholderData,
                            error: query.isError ? query.error : undefined,
                            loadingLabel: "Loading more runs…",
                            onLoadMore: () =>
                                void (query.isRefetchError
                                    ? query.refetch()
                                    : query.fetchNextPage()),
                        }}
                    />
                )}
                {!query.isPending && !query.isError && rows.length === 0 && (
                    <EmptyState
                        message={
                            view === "active"
                                ? "No queued or running jobs."
                                : "No completed runs yet."
                        }
                    />
                )}
            </div>
            {selected && (
                <RunDetailDialog id={selected} onClose={() => setSelected(undefined)} />
            )}
        </Container>
    );
}
