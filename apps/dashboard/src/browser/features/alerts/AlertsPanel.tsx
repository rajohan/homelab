import type { TableSort } from "@homelab/contracts/tableSort";
import {
    BreakableName,
    EmptyState,
    ErrorNotice,
    EventTimeline,
    LoadingState,
    SectionPanel,
    SortControl,
    SummaryStrip,
} from "@homelab/ui";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BellRing } from "lucide-react";
import { useState } from "react";

import { ObservationBadge } from "../operations/ObservationBadge";
import { incidentOptions } from "./incidentQueries";
import { IncidentStatus } from "./IncidentStatus";

/**
 * Present independent current incidents and cursor-paginated resolved history.
 * @returns An independently sortable incident feed.
 */
export function AlertsPanel({ state }: { readonly state: "current" | "resolved" }) {
    const [sort, setSort] = useState<TableSort | null>(null);
    const query = useInfiniteQuery({
        ...incidentOptions(state, sort),
        placeholderData: keepPreviousData,
    });
    const data = query.data?.pages[0];
    const rows = query.data?.pages.flatMap((page) => page.incidents) ?? [];
    const unavailable =
        query.isError ||
        !data?.capturedAt ||
        query.data?.pages.some((page) => !page.configured || page.stale) === true;
    const count = (value: string) =>
        data?.counts.find((item) => item.state === value)?.count ?? 0;
    let emptyMessage = "No current incidents.";
    if (state === "resolved") emptyMessage = "No resolved incidents in retained history.";
    if (state === "current" && unavailable)
        emptyMessage = "Current incident status is unavailable.";
    if (state === "current" && !data?.capturedAt && !query.isError)
        emptyMessage = "Waiting for the first monitoring observation.";
    if (state === "current" && data?.configured === false)
        emptyMessage = "Monitoring incident collection is not configured.";
    const continuation = {
        hasMore: query.hasNextPage,
        loading: query.isFetchingNextPage,
        refreshing: query.isRefetching,
        error: query.isError ? query.error : undefined,
        loadingLabel: "Loading more incidents…",
        onLoadMore: () =>
            void (query.isRefetchError ? query.refetch() : query.fetchNextPage()),
    };
    return (
        <SectionPanel
            title={state === "resolved" ? "Resolution history" : "Current incidents"}

            icon={BellRing}
            badge={
                data && (
                    <ObservationBadge
                        configured={data?.configured ?? true}
                        available={Boolean(data?.capturedAt)}
                        stale={unavailable}
                    />
                )
            }
            actions={
                (state === "resolved" || sort !== null || rows.length > 1) && (
                    <SortControl
                        label={
                            state === "resolved"
                                ? "resolution history"
                                : "current incidents"
                        }
                        sort={sort ?? { id: "time", direction: "descending" }}
                        onChange={(next) =>
                            setSort(
                                next.id === "time" && next.direction === "descending"
                                    ? null
                                    : next
                            )
                        }
                        options={[
                            {
                                value: "time",
                                label:
                                    state === "resolved" ? "Resolved at" : "Started at",
                            },
                            { value: "name", label: "Incident" },
                            { value: "host", label: "Host / service" },
                            ...(state === "current"
                                ? [{ value: "state", label: "Status" }]
                                : []),
                        ]}
                    />
                )
            }
        >
            {query.isPending && <LoadingState label="Loading incidents…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {data && (
                <>
                    {state === "current" && (
                        <SummaryStrip
                            label="Incident counts"
                            items={[
                                {
                                    label: "Active",
                                    attention: !unavailable && count("active") > 0,
                                    value: unavailable ? "—" : count("active"),
                                },
                                {
                                    label: "Suppressed",
                                    value: unavailable ? "—" : count("suppressed"),
                                },
                                {
                                    label: "Resolved",
                                    value: data.capturedAt ? count("resolved") : "—",
                                },
                            ]}
                        />
                    )}
                    {rows.length > 0 && (
                        <EventTimeline
                            scroll={{
                                label:
                                    state === "resolved"
                                        ? "Resolved events"
                                        : "Current events",
                                continuation,
                            }}
                            presentation="feed"
                            events={rows.map((row) => ({
                                id: row.id,
                                time: row.resolvedAt ?? row.startedAt,
                                tone: row.state === "resolved" ? "positive" : "neutral",
                                title: (
                                    <Link
                                        to="/alerts"
                                        hash={true}
                                        hashScrollIntoView={false}
                                        resetScroll={false}
                                        search={{
                                            view: state,
                                            incident: row.id,
                                        }}
                                        className="rounded-sm hover:text-accent-300 hover:underline focus-visible:outline-2 focus-visible:outline-accent-300"
                                    >
                                        <BreakableName>{row.name}</BreakableName>
                                    </Link>
                                ),
                                badge: state === "current" && (
                                    <IncidentStatus
                                        incident={row}
                                        unavailable={unavailable}
                                    />
                                ),
                                detail:
                                    [row.host, row.service].filter(Boolean).join(" · ") ||
                                    "Resource not reported",
                            }))}
                        />
                    )}
                    {rows.length === 0 && (
                        <EmptyState icon={BellRing} title={emptyMessage} />
                    )}
                </>
            )}
        </SectionPanel>
    );
}
