import { Card, ErrorNotice, LoadingState, SectionHeader } from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { History } from "lucide-react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { MiraRunTable } from "./MiraRunTable";

/**
 * Reuse agent execution history in Jobs and Mira without copying run records.
 * @returns Bounded durable run outcomes, stop controls and conversation links.
 */
export function MiraRunHistory() {
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "runs"],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.runs.list.query({
                search: "",
                archived: false,
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 5000,
    });
    const stop = useOperation((id: string) => api.mira.runs.cancel.mutate({ id }));
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Mira runs"
                icon={History}
                description="Agent work and outcomes across chat and automations."
            />
            {query.isPending && <LoadingState label="Loading Mira runs…" />}
            {(query.error || stop.error) && (
                <ErrorNotice error={query.error ?? stop.error} />
            )}
            {rows.length > 0 && (
                <MiraRunTable
                    rows={rows}
                    onStop={(id) => stop.mutate(id)}
                    stoppingId={stop.isPending ? stop.variables : undefined}
                    continuation={{
                        hasMore: query.hasNextPage,
                        loading: query.isFetching,
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
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    No Mira runs yet.
                </p>
            )}
        </Card>
    );
}
