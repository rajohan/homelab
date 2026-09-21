import type { TableSort } from "@homelab/contracts/tableSort";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useState } from "react";

import { DataTable, type DataColumn } from "../../../../components/DataTable/DataTable";
import { Button, ErrorNotice, LoadingState } from "../../../../index";
import { formatDateTimeParts } from "../../../../lib/formatDateTime";
import { queryRefresh } from "../../../../lib/queryRefresh";
import type { IdentityClient } from "../../api/IdentityClient";
import type { ActivityPage } from "../../api/schemas";
import { SettingsSection } from "./SettingsSection";

type Event = ActivityPage["events"][number];
const columns: readonly DataColumn<Event>[] = [
    {
        id: "event",
        sortValue: (event) => event.event,
        label: "Event",
        render: (event) => (
            <span className="font-medium first-letter:uppercase">
                {event.event.replaceAll("_", " ")}
            </span>
        ),
    },
    {
        id: "who",
        sortValue: (event) => event.account,
        label: "Who",
        render: (event) => (
            <div>
                <p>{event.account}</p>
                <p className="text-xs text-primary-400">Associated account</p>
            </div>
        ),
    },
    {
        id: "time",
        sortValue: (event) => event.createdAt,
        label: "Time",
        render: (event) => {
            const [date, time] = formatDateTimeParts(event.createdAt);
            return (
                <time dateTime={event.createdAt} className="block tabular-nums">
                    {date}
                    <span className="block text-primary-400">{time}</span>
                </time>
            );
        },
    },
    {
        id: "details",
        sortValue: (event) => event.event,
        label: "Details",
        render: (event) => (
            <div className="text-xs text-primary-400">
                <code>{event.event}</code>
                <p className="mt-1">Event ID: {event.id}</p>
            </div>
        ),
    },
];

/**
 * Load account-scoped activity in cursor pages and virtualize the rendered history.
 * @returns A responsive audit table with automatic continuation and visible retry controls.
 */
export function ActivityPanel({
    client,
    accountId,
}: {
    readonly client: IdentityClient;
    readonly accountId: string;
}) {
    const [sort, setSort] = useState<TableSort | null>(null);
    const query = useInfiniteQuery({
        queryKey: ["identity", "activity", accountId, ...(sort ? [sort] : [])],
        initialPageParam: null as string | null,
        queryFn: ({ pageParam, signal }) => client.activity(pageParam, signal, sort),
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        retry: false,
        ...queryRefresh("slow"),
    });
    const events = [
        ...new Map(
            query.data?.pages
                .flatMap((page) => page.events)
                .map((event) => [event.id, event])
        ).values(),
    ];
    let content;
    if (query.isPending) content = <LoadingState label="Loading security activity…" />;
    else if (query.isError && !query.data)
        content = (
            <div className="space-y-3">
                <ErrorNotice error={query.error} />
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void query.refetch()}
                >
                    Try again
                </Button>
            </div>
        );
    else if (events.length === 0)
        content = (
            <p className="text-sm text-primary-400">No recent security activity.</p>
        );
    else
        content = (
            <DataTable
                label="Security activity"
                rows={events}
                sort={sort}
                onSortChange={setSort}
                getKey={(event) => event.id}
                columns={columns}
                continuation={{
                    hasMore: query.hasNextPage,
                    loadingLabel: "Loading more events…",
                    loading: query.isFetching,
                    error: query.isError ? query.error : undefined,
                    onLoadMore: () => {
                        void (query.isRefetchError
                            ? query.refetch()
                            : query.fetchNextPage());
                    },
                }}
            />
        );
    return (
        <SettingsSection
            id="security-activity"
            title="Security activity"
            description="A read-only history for your account. Passwords, codes and private credentials are never included."
            icon={ScrollText}
        >
            {content}
        </SettingsSection>
    );
}
