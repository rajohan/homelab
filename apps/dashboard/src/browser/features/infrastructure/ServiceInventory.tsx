import type { ServiceMetric } from "@homelab/contracts/infrastructure";
import {
    ScrollList,
    SearchInput,
    SectionPanel,
    Select,
    SortControl,
    useInventorySort,
} from "@homelab/ui";
import { Activity } from "lucide-react";
import { useState } from "react";

import { ResourceStatus } from "./ResourceStatus";

/**
 * Distinguish end-to-end probes, native services and telemetry collection health.
 * @returns A bounded service list with explicit check categories.
 */
export function ServiceInventory({
    services,
    stale,
}: {
    readonly stale: boolean;
    readonly services: readonly ServiceMetric[];
}) {
    const [kind, setKind] = useState("probe");
    const [search, setSearch] = useState("");
    const checks = services.filter((row) => row.kind === kind);
    const matching = checks.filter((row) =>
        `${row.name} ${row.host}`.toLowerCase().includes(search.toLowerCase())
    );
    const { ordered, control } = useInventorySort(matching, [
        { label: "Check", value: (row) => row.name },
        { label: "Host / component", value: (row) => row.host },
        { label: "Status", value: (row) => (stale ? null : row.state) },
    ]);
    return (
        <SectionPanel
            title="Service checks"
            description="Exporter reachability is separate from application health and end-to-end checks."
            icon={Activity}
            actions={
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        compact
                        icon={Activity}
                        label="Check type"
                        value={kind}
                        onChange={(value) => {
                            setKind(value);
                            setSearch("");
                        }}
                        options={[
                            { value: "probe", label: "End-to-end probes" },
                            { value: "service", label: "Native services" },
                            { value: "exporter", label: "Metrics exporters" },
                        ]}
                    />
                    {matching.length > 1 && (
                        <SortControl label="service checks" {...control} />
                    )}
                </div>
            }
        >
            <SearchInput
                value={search}
                onChange={setSearch}
                label="Search service checks"
                placeholder="Find a check or host…"
            />
            {ordered.length > 0 ? (
                <ScrollList
                    label="Service check results"
                    rows={ordered}
                    getKey={(row) => row.id}
                    framed
                    itemClassName="px-3 py-2.5 sm:px-4"
                    renderItem={(row) => (
                        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                            <div className="min-w-0">
                                <p className="text-sm font-medium wrap-anywhere">
                                    {row.name}
                                </p>
                                <p className="text-xs wrap-anywhere text-primary-400">
                                    {row.host}
                                </p>
                            </div>
                            <ResourceStatus state={stale ? "unknown" : row.state} />
                        </div>
                    )}
                />
            ) : (
                <p className="text-sm text-primary-400">
                    {search
                        ? "No matching checks."
                        : "No checks reported in this category."}
                </p>
            )}
        </SectionPanel>
    );
}
