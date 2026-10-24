import { Button, ErrorNotice, LoadingState, SectionHeader } from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Play, Activity } from "lucide-react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { MiraRunTable } from "./MiraRunTable";

/**
 * Present task-scoped runs and explicit execution controls using the shared run table.
 * @returns Independently refreshed execution history; board movement never starts work.
 */
export function TaskExecution({
    id,
    canStart,
    onStart,
}: {
    readonly id: string;
    readonly canStart: boolean;
    readonly onStart: (version: number, reviewRunId: string | null) => void;
}) {
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "task", id, "execution"],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.tasks.execution.query({
                id,
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 5000,
    });
    const stop = useOperation((runId: string) =>
        api.mira.runs.cancel.mutate({ id: runId })
    );
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    const first = query.data?.pages[0];
    const active = rows.some((run) => ["queued", "running"].includes(run.state));
    return (
        <section className="space-y-3 border-t border-primary-700 pt-4">
            <SectionHeader
                title="Work"
                icon={Activity}
                actions={
                    canStart && first && !query.isError && !active ? (
                        <Button onClick={() => onStart(first.version, first.reviewRunId)}>
                            <Play size={16} aria-hidden="true" />
                            {rows.length > 0 ? "Continue work" : "Start work"}
                        </Button>
                    ) : undefined
                }
            />
            {query.isPending && <LoadingState label="Loading task runs…" />}
            {(query.error || stop.error) && (
                <ErrorNotice error={query.error ?? stop.error} />
            )}
            {rows.length > 0 && (
                <MiraRunTable
                    rows={rows}
                    onStop={(runId) => stop.mutate(runId)}
                    stoppingId={stop.isPending ? stop.variables : undefined}
                    continuation={{
                        hasMore: query.hasNextPage,
                        loading: query.isFetching,
                        error: query.isError ? query.error : undefined,
                        loadingLabel: "Loading older task runs…",
                        onLoadMore: () =>
                            void (query.isRefetchError
                                ? query.refetch()
                                : query.fetchNextPage()),
                    }}
                />
            )}
            {!query.isPending && !query.isError && rows.length === 0 && (
                <p className="text-sm text-primary-400">
                    {canStart
                        ? "No work has been started for this task."
                        : "Assign an unfinished task to Mira to start work."}
                </p>
            )}
        </section>
    );
}
