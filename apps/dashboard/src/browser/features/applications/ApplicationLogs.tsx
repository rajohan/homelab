import type { ManagedApplication } from "@homelab/contracts/applications";
import type { LogCursor } from "@homelab/contracts/logs";
import {
    DetailSection,
    ErrorNotice,
    LoadingState,
    queryRefresh,
    SearchInput,
    Switch,
    TimeRangeSelect,
    VirtualList,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useDeferredValue, useEffect, useRef, useState } from "react";

import { api } from "../../api/client";
import { ApplicationLogLine } from "./ApplicationLogLine";

const ranges = ["15m", "1h", "6h", "24h", "7d"] as const;

/**
 * Inspect a fixed application's Loki history with literal search and cursor continuation.
 * @returns A live first page; loading older records pauses refresh to preserve reading position.
 */
export function ApplicationLogs({
    application,
    anchor,
}: {
    readonly anchor: string;
    readonly application: ManagedApplication;
}) {
    const [range, setRange] = useState<(typeof ranges)[number]>("24h");
    const [search, setSearch] = useState("");
    const [live, setLive] = useState(true);
    const [generation, setGeneration] = useState(0);
    const filter = useDeferredValue(search);
    const section = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        const element = section.current;
        if (!element) return;
        const observer = new IntersectionObserver(
            ([entry]) => setVisible(entry?.isIntersecting ?? false),
            {
                root: element.closest("section[tabindex]"),
                rootMargin: "80px",
            }
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    const query = useInfiniteQuery({
        enabled: visible,
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
        <div ref={section}>
            <DetailSection
                anchor={anchor}
                icon={ScrollText}
                title="Application logs"
                actions={
                    <TimeRangeSelect ranges={ranges} value={range} onChange={setRange} />
                }
            >
                <SearchInput
                    label="Search logs"
                    clearLabel="Clear log search"
                    placeholder="Find text in logs…"
                    value={search}
                    onChange={(value) => setSearch(value.slice(0, 160))}
                />
                <Switch
                    label="Live updates"
                    checked={live}
                    onChange={(enabled) => {
                        setLive(enabled);
                        if (enabled) setGeneration((value) => value + 1);
                    }}
                />
                {query.isPending && <LoadingState label="Loading logs…" />}
                {query.isError && rows.length === 0 && (
                    <ErrorNotice error={query.error} />
                )}
                {!query.isPending && !query.isError && rows.length === 0 && (
                    <p className="text-sm text-primary-400">
                        No matching entries in this time range. Try a wider range or clear
                        the search.
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
                            loading: query.isFetchingNextPage,
                            refreshing: query.isRefetching,
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
            </DetailSection>
        </div>
    );
}
