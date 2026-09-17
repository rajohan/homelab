import { Button, ErrorNotice, LoadingState, Modal, formatDateTime } from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { formatJobActor } from "./formatJobActor";
import { JobStatus } from "./JobStatus";

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
        refetchInterval: 5000,
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
                {query.isError && <ErrorNotice error={query.error} />}
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
                        {run.message && (
                            <p className="rounded-lg border border-primary-700 p-3 text-sm">
                                {run.message}
                            </p>
                        )}
                        <h3 className="font-medium">Run events</h3>
                        <ol
                            aria-label="Run events"
                            className="max-h-72 space-y-3 overflow-y-auto rounded-lg border border-primary-700 bg-primary-950/40 p-3 text-sm"
                        >
                            {query.data?.pages
                                .flatMap((page) => page.events)
                                .map((event) => (
                                    <li key={event.id}>
                                        <p className="wrap-anywhere">{event.action}</p>
                                        <p className="text-xs wrap-anywhere text-primary-400">
                                            {formatDateTime(event.createdAt)} ·{" "}
                                            {formatJobActor(event.actor)}
                                        </p>
                                    </li>
                                ))}
                        </ol>
                        {query.hasNextPage && (
                            <Button
                                variant="secondary"
                                busy={query.isFetchingNextPage}
                                onClick={() => void query.fetchNextPage()}
                            >
                                Load older events
                            </Button>
                        )}
                    </>
                )}
            </div>
        </Modal>
    );
}
