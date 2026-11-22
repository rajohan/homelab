import type { ApplicationMetric } from "@homelab/contracts/infrastructure";
import {
    DetailEntry,
    DetailFacts,
    DetailList,
    formatMetric,
    SearchInput,
} from "@homelab/ui";
import { ArrowUpRight, Boxes } from "lucide-react";
import { useState } from "react";

import { ApplicationDetails } from "./ApplicationDetails";
import { ResourceStatus } from "./ResourceStatus";

/** Show the applications on one host with the service identity and readings together.
 * @returns Searchable, sortable services and access to their own historical charts.
 */
export function HostApplications({
    applications,
    capturedAt,
    cores,
    anchor,
    stale,
}: {
    readonly anchor: string;
    readonly cores: number | null;
    readonly capturedAt: string;
    readonly applications: readonly ApplicationMetric[];
    readonly stale: boolean;
}) {
    const [search, setSearch] = useState("");
    const [selectedId, setSelectedId] = useState<string>();
    const selected = applications.find((row) => row.id === selectedId);
    const rows = applications
        .filter((row) =>
            `${row.name} ${row.project} ${row.host}`
                .toLowerCase()
                .includes(search.toLowerCase())
        )
        .toSorted(
            (a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name)
        );
    return (
        <>
            <DetailList
                icon={Boxes}
                title="Applications"
                anchor={anchor}
                rows={rows}
                getKey={(row) => row.id}
                empty={
                    applications.length > 0
                        ? "No applications match this search."
                        : "No applications reported on this host."
                }
                actions={
                    <SearchInput
                        label="Search host applications"
                        clearLabel="Clear application search"
                        placeholder="Search applications…"
                        value={search}
                        onChange={setSearch}
                    />
                }
                defaultField="Project"
                sorts={[
                    { label: "Application", value: (row) => row.name },
                    { label: "Project", value: (row) => row.project },
                    { label: "Status", value: (row) => row.state },
                    { label: "CPU", value: (row) => row.resources?.cpuPercent },
                    { label: "Memory", value: (row) => row.resources?.memoryUsed },
                    { label: "Restarts", value: (row) => row.restarts },
                ]}
                render={(row) => (
                    <DetailEntry
                        name={
                            <button
                                type="button"
                                aria-label={`Inspect ${row.name}`}
                                onClick={() => setSelectedId(row.id)}
                                className="inline-flex min-h-8 items-center gap-1 rounded text-left text-accent-200 hover:underline focus-visible:outline-2 focus-visible:outline-accent-300"
                            >
                                {row.name}
                                <ArrowUpRight size={14} aria-hidden="true" />
                            </button>
                        }
                        description={[row.project, row.host].filter(Boolean).join(" · ")}
                        accessory={
                            <ResourceStatus state={stale ? "unknown" : row.state} />
                        }
                    >
                        <DetailFacts
                            items={[
                                {
                                    label: "CPU",
                                    value: formatMetric(
                                        row.resources?.cpuPercent,
                                        "percent"
                                    ),
                                },
                                {
                                    label: "Memory",
                                    value: `${formatMetric(row.resources?.memoryUsed, "bytes")} / ${formatMetric(row.resources?.memoryCapacity, "bytes")}`,
                                },
                                { label: "Restarts", value: formatMetric(row.restarts) },
                            ]}
                        />
                    </DetailEntry>
                )}
            />
            {selected && (
                <ApplicationDetails
                    application={selected}
                    applications={applications}
                    capturedAt={capturedAt}
                    cores={cores}
                    stale={stale}
                    onClose={() => setSelectedId(undefined)}
                />
            )}
        </>
    );
}
