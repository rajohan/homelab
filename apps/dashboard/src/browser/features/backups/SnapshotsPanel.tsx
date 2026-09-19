import {
    Card,
    DataTable,
    ErrorNotice,
    LoadingState,
    SearchInput,
    SectionHeader,
    formatDateTime,
    formatMetric,
    queryRefresh,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { MetricStat } from "../infrastructure/MetricStat";
import { ObservationBadge } from "../operations/ObservationBadge";
import { SnapshotDetails } from "./SnapshotDetails";

/**
 * Keep snapshot inventory separate from backup/verification tasks that have no archive size.
 * @returns Logical snapshot sizes, counts and row-opened snapshot details.
 */
export function SnapshotsPanel() {
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState<string | null>(null);
    const query = useQuery({
        queryKey: ["operations", "backup-catalog"],
        queryFn: ({ signal }) => api.backups.catalog.query(undefined, { signal }),
        ...queryRefresh("normal"),
        retry: false,
    });
    const data = query.data;
    const stale = query.isError || (data?.stale ?? true);
    const groups = data?.inventory?.groups ?? [];
    const group = groups.find((row) => row.id === selected);
    const rows = groups.filter((row) =>
        `${row.name} ${row.datastore} ${row.namespace}`
            .toLowerCase()
            .includes(search.toLowerCase())
    );
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Backup snapshots"
                description="Retained backups and their logical sizes."
                icon={Layers}
                actions={
                    <ObservationBadge
                        configured={data?.configured ?? true}
                        available={Boolean(data?.inventory)}
                        stale={stale}
                    />
                }
            />
            {query.isPending && <LoadingState label="Loading backup snapshots…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {data?.inventory && (
                <dl className="grid grid-cols-2 gap-3">
                    <MetricStat label="Backup groups" value={groups.length} />
                    <MetricStat
                        label="Snapshots"
                        value={groups.reduce(
                            (total, row) => total + row.snapshotCount,
                            0
                        )}
                    />
                </dl>
            )}
            <SearchInput
                label="Search snapshot groups"
                clearLabel="Clear snapshot search"
                placeholder="Find a backup group or datastore…"
                value={search}
                onChange={setSearch}
            />
            {rows.length > 0 ? (
                <DataTable
                    label="Backup groups"
                    compact
                    rows={rows}
                    getKey={(row) => row.id}
                    rowAction={{
                        label: (row) => `Inspect snapshots for ${row.name}`,
                        onSelect: (row) => setSelected(row.id),
                    }}
                    columns={[
                        {
                            id: "name",
                            label: "Backup group",
                            mobile: "title",
                            render: (row) => row.name,
                        },
                        {
                            id: "datastore",
                            label: "Datastore",
                            render: (row) =>
                                row.namespace
                                    ? `${row.datastore} / ${row.namespace}`
                                    : row.datastore,
                        },
                        {
                            id: "count",
                            label: "Snapshots",
                            render: (row) => row.snapshotCount,
                        },
                        {
                            id: "size",
                            label: "Latest logical size",
                            render: (row) => formatMetric(row.latestSizeBytes, "bytes"),
                        },
                        {
                            id: "latest",
                            label: "Latest snapshot",
                            mobile: "wide",
                            render: (row) => formatDateTime(row.latestAt),
                        },
                    ]}
                />
            ) : (
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    {search
                        ? "No matching backup groups."
                        : "No snapshot inventory is available."}
                </p>
            )}
            {group && (
                <SnapshotDetails
                    group={group}
                    stale={stale}
                    onClose={() => setSelected(null)}
                />
            )}
        </Card>
    );
}
