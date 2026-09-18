import {
    Card,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    queryRefresh,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { History, ListTodo } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
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
    const query = useInfiniteQuery({
        queryKey: ["operations", "jobs", "history", action, view],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }) =>
            api.jobs.list.query(
                {
                    ...(pageParam ? { before: pageParam } : {}),
                    ...(action ? { action } : {}),
                    view,
                },
                { signal }
            ),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
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
            {query.isPending && <LoadingState label="Loading jobs…" />}
            {query.isError && rows.length === 0 && <ErrorNotice error={query.error} />}
            {rows.length > 0 && (
                <JobRunTable
                    rows={rows}
                    onSelect={setSelected}
                    continuation={{
                        hasMore: query.hasNextPage,
                        loading: query.isFetching,
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
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    {view === "active"
                        ? "No queued or running jobs."
                        : "No completed runs yet."}
                </p>
            )}
            {selected && (
                <RunDetailDialog id={selected} onClose={() => setSelected(undefined)} />
            )}
        </Container>
    );
}
