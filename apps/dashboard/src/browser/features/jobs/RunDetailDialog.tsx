import {
    DetailFacts,
    DetailSection,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    Modal,
    queryRefresh,
    VirtualList,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { History, Play } from "lucide-react";

import { api } from "../../api/client";
import { formatJobActor } from "./formatJobActor";
import { JobStatus } from "./JobStatus";
import { MaintenanceResults } from "./MaintenanceResults";
import { RunEvent } from "./RunEvent";
import { RunProgress } from "./RunProgress";

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
            titleAccessory={run && <JobStatus state={run.state} />}
            keepTitleAccessoryInline
            size="wide"
            description="Execution status and recorded events."
            onClose={onClose}
        >
            <div className="space-y-4">
                {query.isPending && <LoadingState label="Loading run…" />}
                {query.isError && !run && <ErrorNotice error={query.error} />}
                {run && (
                    <>
                        <DetailSection icon={Play} title="Execution">
                            <RunProgress run={run} />
                            <DetailFacts
                                items={[
                                    { label: "Run ID", value: run.id },
                                    {
                                        label: "Requested by",
                                        value: formatJobActor(run.requestedBy),
                                    },
                                    { label: "Work size", value: run.resourceClass },
                                    {
                                        label: "Attempt",
                                        value: `${run.attempt} / ${run.attemptLimit}`,
                                    },
                                    {
                                        label: "Timeout",
                                        value: `${run.timeoutMs / 1000} seconds`,
                                    },
                                    {
                                        label: "Safe to retry",
                                        value: run.retrySafe ? "Yes" : "No",
                                    },
                                    {
                                        label: "Queued",
                                        value: formatDateTime(run.createdAt),
                                    },
                                    {
                                        label: "Started",
                                        value: run.startedAt
                                            ? formatDateTime(run.startedAt)
                                            : "Not started",
                                    },
                                    {
                                        label: "Finished",
                                        value: run.finishedAt
                                            ? formatDateTime(run.finishedAt)
                                            : "Not finished",
                                    },
                                ]}
                            />
                        </DetailSection>
                        <MaintenanceResults results={run.results ?? []} />
                        <DetailSection icon={History} title="Run events">
                            <VirtualList
                                label="Run events"
                                className="max-h-72 space-y-3 overflow-y-auto text-sm"
                                rows={
                                    query.data?.pages.flatMap((page) => page.events) ?? []
                                }
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
                        </DetailSection>
                    </>
                )}
            </div>
        </Modal>
    );
}
