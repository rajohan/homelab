import type { ManagedApplication } from "@homelab/contracts/applications";
import type { LogCursor } from "@homelab/contracts/logs";
import {
    ErrorNotice,
    LoadingState,
    SearchInput,
    Select,
    Switch,
    VirtualList,
    queryRefresh,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";

import { api } from "../../api/client";
import { ApplicationLogLine } from "./ApplicationLogLine";

/**
 * Inspect a fixed application's Loki history with literal search and cursor continuation.
 * @returns A live first page; loading older records pauses refresh to preserve reading position.
 */
export function ApplicationLogs({
    application,
}: {
    readonly application: ManagedApplication;
}) {
    const [range, setRange] = useState<"15m" | "1h" | "6h" | "24h">("1h");
    const [search, setSearch] = useState("");
    const [live, setLive] = useState(true);
    const [generation, setGeneration] = useState(0);
    const filter = useDeferredValue(search);
    const query = useInfiniteQuery({
        queryKey: [
            "operations",
            "applications",
            "logs",
            application.id,
            range,
            filter,
            generation,
        ],
        initialPageParam: undefined as LogCursor,
        queryFn: ({ pageParam, signal }) =>
            api.applications.logs.query(
                {
                    host: application.host,
                    container: application.containerId,
                    range,
                    search: filter,
                    ...(pageParam ? { cursor: pageParam } : {}),
                },
                { signal }
            ),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        ...queryRefresh("fast"),
        refetchInterval: live ? 5000 : false,
        refetchOnWindowFocus: live,
        refetchOnReconnect: live,
        retry: false,
        gcTime: 60_000,
    });
    const rows = query.data?.pages.flatMap((page) => page.entries) ?? [];
    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <SearchInput
                    label="Search logs"
                    clearLabel="Clear log search"
                    placeholder="Find text in logs…"
                    value={search}
                    onChange={(value) => setSearch(value.slice(0, 160))}
                />
                <Select
                    label="Time range"
                    value={range}
                    onChange={setRange}
                    options={["15m", "1h", "6h", "24h"].map((value) => ({
                        value: value as typeof range,
                        label: `Last ${value}`,
                    }))}
                />
            </div>
            <Switch
                label="Live updates"
                checked={live}
                onChange={(enabled) => {
                    setLive(enabled);
                    if (enabled) setGeneration((value) => value + 1);
                }}
            />
            {query.isPending && <LoadingState label="Loading logs…" />}
            {query.isError && rows.length === 0 && <ErrorNotice error={query.error} />}
            {!query.isPending && !query.isError && rows.length === 0 && (
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    No matching log entries.
                </p>
            )}
            {rows.length > 0 && (
                <VirtualList
                    label="Application logs"
                    className="max-h-[min(30rem,55dvh)] overflow-y-auto rounded-lg border border-primary-700 bg-primary-950"
                    itemClassName="border-b border-primary-700/70 pb-0"
                    rows={rows}
                    getKey={(entry) => entry.id}
                    renderItem={(entry) => <ApplicationLogLine entry={entry} />}
                    continuation={{
                        hasMore: query.hasNextPage,
                        loading: query.isFetching,
                        error: query.isError ? query.error : undefined,
                        loadingLabel: "Loading older logs…",
                        onLoadMore: () => {
                            setLive(false);
                            void (query.isRefetchError
                                ? query.refetch()
                                : query.fetchNextPage());
                        },
                    }}
                />
            )}
        </div>
    );
}
