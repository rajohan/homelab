import type { Incident, IncidentCursor } from "@homelab/contracts/alerts";
import {
    Card,
    DataTable,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    Select,
    buttonStyles,
    formatDateTime,
    queryRefresh,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BellRing } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { MetricStat } from "../infrastructure/MetricStat";
import { ObservationBadge } from "../operations/ObservationBadge";
import { IncidentDetails } from "./IncidentDetails";
import { IncidentStatus } from "./IncidentStatus";

/**
 * Present independent current incidents and cursor-paginated resolved history.
 * @returns A compact overview module or full virtualized incident history.
 */
export function AlertsPanel({ compact = false }: { readonly compact?: boolean }) {
    const [state, setState] = useState<"current" | "resolved">("current");
    const [selected, setSelected] = useState<Incident | null>(null);
    const query = useInfiniteQuery({
        queryKey: ["operations", "alerts", state],
        initialPageParam: undefined as IncidentCursor | undefined,
        queryFn: ({ pageParam, signal }) =>
            api.alerts.list.query(
                { state, ...(pageParam ? { before: pageParam } : {}) },
                { signal }
            ),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        ...queryRefresh("fast"),
        retry: false,
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
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Monitoring incidents"
                description="Active problems and their resolution history."
                icon={BellRing}
                actions={
                    <ObservationBadge
                        configured={data?.configured ?? true}
                        available={Boolean(data?.capturedAt)}
                        stale={unavailable}
                    />
                }
            />
            {query.isPending && <LoadingState label="Loading incidents…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {data && (
                <>
                    <dl className="grid grid-cols-3 gap-3">
                        <MetricStat
                            label="Active"
                            value={unavailable ? "—" : count("active")}
                        />
                        <MetricStat
                            label="Suppressed"
                            value={unavailable ? "—" : count("suppressed")}
                        />
                        <MetricStat
                            label="Resolved"
                            value={data.capturedAt ? count("resolved") : "—"}
                        />
                    </dl>
                    {!compact && (
                        <Select
                            label="Incident history"
                            value={state}
                            onChange={setState}
                            options={[
                                { value: "current", label: "Current incidents" },
                                { value: "resolved", label: "Resolved incidents" },
                            ]}
                        />
                    )}
                    {!compact && rows.length > 0 && (
                        <DataTable
                            label="Monitoring incidents"
                            compact
                            rows={rows}
                            getKey={(row) => row.id}
                            rowAction={{
                                label: (row) => `Inspect ${row.name}`,
                                onSelect: setSelected,
                            }}
                            columns={[
                                {
                                    id: "name",
                                    label: "Incident",
                                    mobile: "title",
                                    render: (row) => row.name,
                                },
                                {
                                    id: "host",
                                    label: "Host / service",
                                    render: (row) =>
                                        [row.host, row.service]
                                            .filter(Boolean)
                                            .join(" · ") || "Not reported",
                                },
                                {
                                    id: "state",
                                    label: "Status",
                                    render: (row) => (
                                        <IncidentStatus
                                            incident={row}
                                            unavailable={unavailable}
                                        />
                                    ),
                                },
                                {
                                    id: "time",
                                    label: state === "resolved" ? "Resolved" : "Started",
                                    render: (row) =>
                                        formatDateTime(row.resolvedAt ?? row.startedAt),
                                },
                            ]}
                            continuation={{
                                hasMore: query.hasNextPage,
                                loading: query.isFetching,
                                error: query.isError ? query.error : undefined,
                                loadingLabel: "Loading more incidents…",
                                onLoadMore: () =>
                                    void (query.isRefetchError
                                        ? query.refetch()
                                        : query.fetchNextPage()),
                            }}
                        />
                    )}
                    {!compact && rows.length === 0 && (
                        <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                            {emptyMessage}
                        </p>
                    )}
                    {compact && (
                        <Link
                            to="/alerts"
                            className={buttonStyles({
                                variant: "secondary",
                                className: "w-full",
                            })}
                        >
                            View incidents
                        </Link>
                    )}
                </>
            )}
            {selected && (
                <IncidentDetails
                    incident={rows.find((row) => row.id === selected.id) ?? selected}
                    unavailable={
                        unavailable || !rows.some((row) => row.id === selected.id)
                    }
                    onClose={() => setSelected(null)}
                />
            )}
        </Card>
    );
}
