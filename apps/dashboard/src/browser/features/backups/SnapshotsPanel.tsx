import {
    DetailEntry,
    DetailFacts,
    ErrorNotice,
    formatDateTime,
    formatMetric,
    LoadingState,
    ScrollList,
    SectionPanel,
    SummaryStrip,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Layers } from "lucide-react";
import { useState } from "react";

import { ObservationBadge } from "../operations/ObservationBadge";
import { backupCatalogQuery } from "./backupCatalogQuery";
import { SnapshotDetails } from "./SnapshotDetails";

/**
 * Keep snapshot inventory separate from backup/verification tasks that have no archive size.
 * @returns Logical snapshot sizes, counts and row-opened snapshot details.
 */
export function SnapshotsPanel() {
    const [selected, setSelected] = useState<string | null>(null);
    const query = useQuery(backupCatalogQuery);
    const data = query.data;
    const stale = !data?.configured || query.isError || (data?.stale ?? true);
    const groups = data?.inventory?.groups ?? [];
    const group = groups.find((row) => row.id === selected);
    return (
        <SectionPanel
            title="Backup snapshots"
            description="Retained backups and their logical sizes."
            icon={Layers}
            badge={
                <ObservationBadge
                    configured={data?.configured ?? true}
                    available={Boolean(data?.inventory)}
                    stale={stale}
                />
            }
        >
            {query.isPending && <LoadingState label="Loading backup snapshots…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {data?.inventory && (
                <SummaryStrip
                    label="Retained backup inventory"
                    items={[
                        { label: "Backup groups", value: groups.length },
                        {
                            label: "Snapshots",
                            value: groups.reduce(
                                (total, row) => total + row.snapshotCount,
                                0
                            ),
                        },
                    ]}
                />
            )}
            {groups.length > 0 ? (
                <ScrollList
                    label="Backup groups"
                    rows={groups.toSorted((a, b) =>
                        a.name.localeCompare(b.name, undefined, { numeric: true })
                    )}
                    getKey={(row) => row.id}
                    className="@container/entries"
                    framed
                    itemClassName="p-3 sm:px-4"
                    renderItem={(row) => (
                        <DetailEntry
                            name={
                                <button
                                    type="button"
                                    className="inline-flex min-h-10 items-center gap-2 rounded text-left font-semibold hover:text-accent-300 focus-visible:outline-2 focus-visible:outline-accent-300"
                                    aria-label={`Inspect snapshots for ${row.name}`}
                                    onClick={() => setSelected(row.id)}
                                >
                                    {row.name}
                                    <ChevronRight size={14} aria-hidden="true" />
                                </button>
                            }
                            description={[row.datastore, row.namespace]
                                .filter(Boolean)
                                .join(" / ")}
                        >
                            <DetailFacts
                                items={[
                                    { label: "Snapshots", value: row.snapshotCount },
                                    {
                                        label: "Latest logical size",
                                        value: formatMetric(row.latestSizeBytes, "bytes"),
                                    },
                                    {
                                        label: "Latest snapshot",
                                        value: formatDateTime(row.latestAt),
                                    },
                                ]}
                            />
                        </DetailEntry>
                    )}
                />
            ) : (
                !query.isPending &&
                !query.isError && (
                    <p className="rounded-lg border border-primary-700 bg-surface-empty p-4 text-sm text-primary-400">
                        No snapshot inventory is available.
                    </p>
                )
            )}
            {group && (
                <SnapshotDetails
                    group={group}
                    stale={stale}
                    onClose={() => setSelected(null)}
                />
            )}
        </SectionPanel>
    );
}
