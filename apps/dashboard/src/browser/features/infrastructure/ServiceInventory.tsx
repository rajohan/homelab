import type { ServiceMetric } from "@homelab/contracts/infrastructure";
import { Card, DataTable, SectionHeader, Select } from "@homelab/ui";
import { Activity } from "lucide-react";
import { useState } from "react";

import { ResourceStatus } from "./ResourceStatus";

/**
 * Distinguish end-to-end probes, native services and telemetry collection health.
 * @returns A bounded service table with explicit check categories.
 */
export function ServiceInventory({
    services,
}: {
    readonly services: readonly ServiceMetric[];
}) {
    const [kind, setKind] = useState("probe");
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Service checks"
                description="Exporter reachability is separate from application health and end-to-end checks."
                icon={Activity}
                actions={
                    <div className="w-full shrink-0 min-[30rem]:w-56">
                        <Select
                            label="Check type"
                            value={kind}
                            onChange={setKind}
                            options={[
                                { value: "probe", label: "End-to-end probes" },
                                { value: "service", label: "Native services" },
                                { value: "exporter", label: "Metrics exporters" },
                            ]}
                        />
                    </div>
                }
            />
            <DataTable
                label="Service checks"
                compact
                rows={services.filter((row) => row.kind === kind)}
                getKey={(row) => row.id}
                columns={[
                    {
                        id: "name",
                        label: "Check",
                        mobile: "title",
                        render: (row) => row.name,
                    },
                    { id: "host", label: "Host / component", render: (row) => row.host },
                    {
                        id: "state",
                        label: "Status",
                        render: (row) => <ResourceStatus state={row.state} />,
                    },
                ]}
            />
        </Card>
    );
}
