import type { ApplicationMetric } from "@homelab/contracts/infrastructure";
import { Card, DataTable, SearchInput, SectionHeader, formatMetric } from "@homelab/ui";
import { Boxes } from "lucide-react";
import { useState } from "react";

import { ApplicationDetails } from "./ApplicationDetails";
import { ApplicationMemory } from "./ApplicationMemory";
import { ResourceStatus } from "./ResourceStatus";

/**
 * List expected applications, including unhealthy or missing services and collector failures.
 * @returns Application state filtered by host, project or service name.
 */
export function ApplicationInventory({
    applications,
}: {
    readonly applications: readonly ApplicationMetric[];
}) {
    const [search, setSearch] = useState("");
    const [selectedId, setSelectedId] = useState<string>();
    const selected = applications.find((application) => application.id === selectedId);
    const rows = applications.filter((row) =>
        `${row.host} ${row.project} ${row.name}`
            .toLowerCase()
            .includes(search.toLowerCase())
    );
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Applications"
                description="Select an application for health details and resource history. Unknown means monitoring cannot confirm its current state."
                icon={Boxes}
            />
            <SearchInput
                label="Search applications"
                clearLabel="Clear application search"
                placeholder="Search apps, projects or hosts…"
                value={search}
                onChange={setSearch}
            />
            <DataTable
                label="Applications"
                compact
                rows={rows}
                getKey={(row) => row.id}
                rowAction={{
                    label: (row) => `Inspect ${row.name}`,
                    onSelect: (row) => setSelectedId(row.id),
                }}
                columns={[
                    {
                        id: "name",
                        sortValue: (row) => row.name,
                        label: "Application",
                        mobile: "title",
                        render: (row) => (
                            <div className="font-semibold">
                                {row.name}
                                <p className="mt-1 text-xs font-normal text-primary-400">
                                    {row.project}
                                </p>
                            </div>
                        ),
                    },
                    {
                        id: "host",
                        sortValue: (row) => row.host,
                        label: "Host",
                        render: (row) => row.host,
                    },
                    {
                        id: "state",
                        sortValue: (row) => row.state,
                        label: "Status",
                        render: (row) => <ResourceStatus state={row.state} />,
                    },
                    {
                        id: "cpu",
                        sortValue: (row) => row.resources?.cpuPercent,
                        label: "CPU",
                        render: (row) =>
                            formatMetric(row.resources?.cpuPercent ?? null, "percent"),
                    },
                    {
                        id: "memory",
                        sortValue: (row) => row.resources?.memoryUsed,
                        label: "Memory",
                        width: "w-1/4",
                        render: (row) => <ApplicationMemory resources={row.resources} />,
                    },
                    {
                        id: "restarts",
                        sortValue: (row) => row.restarts,
                        label: "Restarts",
                        render: (row) => row.restarts ?? "Not reported",
                    },
                ]}
            />
            {selected && (
                <ApplicationDetails
                    key={selected.id}
                    application={selected}
                    onClose={() => setSelectedId(undefined)}
                />
            )}
        </Card>
    );
}
