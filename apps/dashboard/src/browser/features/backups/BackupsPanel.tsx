import {
    Card,
    DataTable,
    ErrorNotice,
    LoadingState,
    SearchInput,
    SectionHeader,
    buttonStyles,
    formatDateTime,
    queryRefresh,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Archive } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { MetricStat } from "../infrastructure/MetricStat";
import { ObservationBadge } from "../operations/ObservationBadge";
import { BackupStatus } from "./BackupStatus";

/**
 * Present backup and verification observations without granting archive or restore access.
 * @returns Independent freshness, status totals and a shared virtualized task table.
 */
export function BackupsPanel({ compact = false }: { readonly compact?: boolean }) {
    const [search, setSearch] = useState("");
    const query = useQuery({
        queryKey: ["operations", "backups"],
        queryFn: ({ signal }) => api.backups.inventory.query(undefined, { signal }),
        ...queryRefresh("normal"),
        retry: false,
    });
    const data = query.data;
    const stale = query.isError || (data?.stale ?? true);
    const rows = data?.inventory?.backups ?? [];
    const filtered = rows.filter((row) =>
        `${row.host} ${row.task}`.toLowerCase().includes(search.toLowerCase())
    );
    const count = (states: readonly string[]) =>
        rows.filter((row) => states.includes(row.state)).length;
    let unknownCount: number | string = count(["unknown"]);
    if (stale) unknownCount = rows.length > 0 ? rows.length : "—";
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Backup protection"
                description="Backup completion, verification and freshness."
                icon={Archive}
                actions={
                    <ObservationBadge
                        configured={data?.configured ?? true}
                        available={Boolean(data?.inventory)}
                        stale={stale}
                    />
                }
            />
            {query.isPending && <LoadingState label="Loading backup status…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {data && (
                <>
                    <dl className="grid grid-cols-3 gap-3">
                        <MetricStat
                            label="Healthy"
                            value={stale ? "—" : count(["healthy"])}
                        />
                        <MetricStat
                            label="Needs attention"
                            value={stale ? "—" : count(["failed", "overdue"])}
                        />
                        <MetricStat label="Unknown" value={unknownCount} />
                    </dl>
                    {!compact && (
                        <SearchInput
                            label="Search backups"
                            clearLabel="Clear backup search"
                            placeholder="Find a host or backup task…"
                            value={search}
                            onChange={setSearch}
                        />
                    )}
                    {!compact && filtered.length > 0 && (
                        <DataTable
                            label="Backup tasks"
                            compact
                            rows={filtered}
                            getKey={(row) => row.id}
                            columns={[
                                {
                                    id: "task",
                                    label: "Task",
                                    mobile: "title",
                                    render: (row) => row.task,
                                },
                                { id: "host", label: "Host", render: (row) => row.host },
                                {
                                    id: "state",
                                    label: "Status",
                                    render: (row) => (
                                        <BackupStatus
                                            state={stale ? "unknown" : row.state}
                                        />
                                    ),
                                },
                                {
                                    id: "success",
                                    label: "Last successful backup",
                                    render: (row) =>
                                        row.lastSuccessAt
                                            ? formatDateTime(row.lastSuccessAt)
                                            : "Not reported",
                                },
                                {
                                    id: "failure",
                                    label: "Last failure",
                                    render: (row) =>
                                        row.lastFailureAt
                                            ? formatDateTime(row.lastFailureAt)
                                            : "None reported",
                                },
                            ]}
                        />
                    )}
                    {!compact && filtered.length === 0 && (
                        <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                            {search
                                ? "No matching backup tasks."
                                : "No backup observations are available."}
                        </p>
                    )}
                    {compact && (
                        <Link
                            to="/backups"
                            className={buttonStyles({
                                variant: "secondary",
                                className: "w-full",
                            })}
                        >
                            View backups
                        </Link>
                    )}
                </>
            )}
        </Card>
    );
}
