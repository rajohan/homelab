import {
    VirtualList,
    queryRefresh,
    ErrorNotice,
    LoadingState,
    Modal,
    formatDateTime,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { formatJobActor } from "./formatJobActor";
import { JobStatus } from "./JobStatus";
import { RunEvent } from "./RunEvent";

/**
 * Show one run's immutable policy snapshot and bounded audit history, never its payload.
 * @returns A read-only run inspector that remains current while work is running.
 */
export function RunDetailDialog({
    id,
    onClose,
}: {
    readonly id: string;
    readonly onClose: () => void;
}) {
    const query = useInfiniteQuery({
        queryKey: ["operations", "jobs", "detail", id],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }) =>
            api.jobs.detail.query(
                { id, ...(pageParam ? { before: pageParam } : {}) },
                { signal }
            ),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        ...queryRefresh("progress"),
        refetchInterval: (current) => {
            const state = current.state.data?.pages[0]?.run.state;
            return !state || state === "queued" || state === "running"
                ? queryRefresh("progress").refetchInterval
                : false;
        },
        retry: false,
    });
    const run = query.data?.pages[0]?.run;
    return (
        <Modal
            title={run?.label ?? "Run details"}
            description="Execution status and recorded events."
            onClose={onClose}
        >
            <div className="space-y-4">
                {query.isPending && <LoadingState label="Loading run…" />}
                {query.isError && !run && <ErrorNotice error={query.error} />}
                {run && (
                    <>
                        <JobStatus state={run.state} />
                        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm [&_dd]:wrap-anywhere [&_dt]:text-primary-400">
                            <dt>Run ID</dt>
                            <dd>{run.id}</dd>
                            <dt>Requested by</dt>
                            <dd>{formatJobActor(run.requestedBy)}</dd>
                            <dt>Work size</dt>
                            <dd>{run.resourceClass}</dd>
                            <dt>Attempt</dt>
                            <dd>
                                {run.attempt} / {run.attemptLimit}
                            </dd>
                            <dt>Timeout</dt>
                            <dd>{run.timeoutMs / 1000} seconds</dd>
                            <dt>Safe to retry</dt>
                            <dd>{run.retrySafe ? "Yes" : "No"}</dd>
                            <dt>Queued</dt>
                            <dd>{formatDateTime(run.createdAt)}</dd>
                            <dt>Started</dt>
                            <dd>
                                {run.startedAt
                                    ? formatDateTime(run.startedAt)
                                    : "Not started"}
                            </dd>
                            <dt>Finished</dt>
                            <dd>
                                {run.finishedAt
                                    ? formatDateTime(run.finishedAt)
                                    : "Not finished"}
                            </dd>
                        </dl>
                        <h3 className="font-medium">Run events</h3>
                        <VirtualList
                            label="Run events"
                            className="max-h-72 space-y-3 overflow-y-auto rounded-lg border border-primary-700 bg-primary-950/40 p-3 text-sm"
                            rows={query.data?.pages.flatMap((page) => page.events) ?? []}
                            getKey={(event) => event.id}
                            continuation={{
                                hasMore: query.hasNextPage,
                                loading: query.isFetching,
                                error: query.isError ? query.error : undefined,
                                loadingLabel: "Loading older events…",
                                onLoadMore: () =>
                                    void (query.isRefetchError
                                        ? query.refetch()
                                        : query.fetchNextPage()),
                            }}
                            renderItem={(event) => <RunEvent event={event} />}
                        />
                    </>
                )}
            </div>
        </Modal>
    );
}
