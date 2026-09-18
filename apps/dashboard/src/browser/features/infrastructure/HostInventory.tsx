import type {
    InfrastructureHost,
    FilesystemMetric,
} from "@homelab/contracts/infrastructure";
import {
    Card,
    DataTable,
    SearchInput,
    SectionHeader,
    Select,
    formatMetric,
} from "@homelab/ui";
import { Server } from "lucide-react";
import { useState } from "react";

import { HostStorageUsage } from "./HostStorageUsage";
import { ResourceStatus } from "./ResourceStatus";
import { ResourceUsage } from "./ResourceUsage";

const memoryLabels = {
    guest: "Inside guest / OS",
    hypervisor: "Hypervisor reported",
    unavailable: "Not reported",
};

/**
 * Show every hypervisor, guest and additional monitored host with explicit resource sources.
 * @returns A searchable responsive inventory whose rows open host details.
 */
export function HostInventory({
    hosts,
    filesystems,
    onSelect,
}: {
    readonly hosts: readonly InfrastructureHost[];
    readonly filesystems: readonly FilesystemMetric[];
    readonly onSelect: (host: InfrastructureHost) => void;
}) {
    const [search, setSearch] = useState("");
    const [kind, setKind] = useState("all");
    const rows = hosts.filter(
        (host) =>
            (kind === "all" || host.kind === kind) &&
            `${host.name} ${host.guestId ?? ""} ${host.node ?? ""}`
                .toLowerCase()
                .includes(search.toLowerCase())
    );
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Hosts and guests"
                description="Select a host for resource history, interfaces, disks and filesystems."
                icon={Server}
            />
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
                <SearchInput
                    label="Search hosts"
                    clearLabel="Clear host search"
                    placeholder="Search hosts, nodes or VM IDs…"
                    value={search}
                    onChange={setSearch}
                />
                <Select
                    label="Host type"
                    value={kind}
                    onChange={setKind}
                    options={[
                        { value: "all", label: "All types" },
                        { value: "node", label: "PVE nodes" },
                        { value: "vm", label: "Virtual machines" },
                        { value: "container", label: "Containers" },
                        { value: "host", label: "Other hosts" },
                    ]}
                />
            </div>
            <DataTable
                label="Hosts and guests"
                compact
                rows={rows}
                getKey={(host) => host.id}
                rowAction={{ label: (host) => `Inspect ${host.name}`, onSelect }}
                columns={[
                    {
                        id: "name",
                        label: "Host",
                        mobile: "title",
                        render: (host) => (
                            <div>
                                <span className="font-semibold text-primary-50">
                                    {host.name}
                                </span>
                                <p className="mt-1 text-xs text-primary-400">
                                    {host.guestId ?? host.kind}
                                    {host.node && host.kind !== "node"
                                        ? ` · ${host.node}`
                                        : ""}
                                </p>
                            </div>
                        ),
                    },
                    {
                        id: "state",
                        label: "Status",
                        render: (host) => <ResourceStatus state={host.state} />,
                    },
                    {
                        id: "cpu",
                        label: "CPU",
                        render: (host) => (
                            <div>
                                {formatMetric(host.cpuPercent, "percent")}
                                <p className="mt-1 text-xs text-primary-400">
                                    {host.cores ?? "Unknown"} cores
                                </p>
                            </div>
                        ),
                    },
                    {
                        id: "memory",
                        label: "Memory",
                        width: "w-1/4",
                        render: (host) => (
                            <ResourceUsage
                                used={host.memoryUsed}
                                total={host.memoryTotal}
                                description={memoryLabels[host.memorySource]}
                            />
                        ),
                    },
                    {
                        id: "disk",
                        label: "Disk usage",
                        width: "w-1/4",
                        render: (host) => (
                            <HostStorageUsage
                                host={host.host}
                                filesystems={filesystems}
                                systemOnly={host.kind === "node"}
                            />
                        ),
                    },
                    {
                        id: "uptime",
                        label: "Uptime",
                        render: (host) => formatMetric(host.uptime, "seconds"),
                    },
                ]}
            />
            {rows.length === 0 && (
                <p className="text-sm text-primary-400">No hosts match these filters.</p>
            )}
        </Card>
    );
}
