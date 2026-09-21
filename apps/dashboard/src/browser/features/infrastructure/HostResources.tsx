import type {
    InfrastructureHost,
    InfrastructureInventory,
} from "@homelab/contracts/infrastructure";
import { DataTable, Switch, formatMetric } from "@homelab/ui";
import { useState } from "react";

import { ApplicationInventory } from "./ApplicationInventory";
import { ResourceUsage } from "./ResourceUsage";

function booleanLabel(value: boolean | null, yes: string, no: string): string {
    if (value === null) return "Unknown";
    return value ? yes : no;
}

/**
 * Show individual guest resources without combining aliases or virtual network traffic.
 * @returns The requested host-scoped resource table.
 */
export function HostResources({
    inventory,
    host,
    section,
}: {
    readonly inventory: InfrastructureInventory;
    readonly host: InfrastructureHost;
    readonly section: string;
}) {
    const [virtual, setVirtual] = useState(false);
    if (section === "applications")
        return (
            <ApplicationInventory
                applications={inventory.applications.filter(
                    (row) => row.host === host.host
                )}
            />
        );
    if (
        !host.guestMetricsAvailable &&
        !(
            section === "filesystems" &&
            inventory.filesystems.some((row) => row.host === host.host)
        )
    )
        return (
            <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                Guest-level metrics are unavailable. Hypervisor metrics remain available
                under History. Install or restore the guest exporter for filesystem and
                interface details.
            </p>
        );
    if (section === "filesystems")
        return (
            <div className="space-y-3">
                <p className="text-sm text-primary-400">
                    Actual filesystem usage. Mounted aliases and ZFS datasets may share
                    capacity; rows are not summed.
                </p>
                <DataTable
                    label={`${host.name} filesystems`}
                    compact
                    rows={inventory.filesystems.filter((row) => row.host === host.host)}
                    getKey={(row) => row.id}
                    columns={[
                        {
                            id: "mount",
                            sortValue: (row) => row.mount,
                            label: "Mount",
                            mobile: "title",
                            render: (row) => (
                                <div className="wrap-anywhere">
                                    {row.mount}
                                    <p className="mt-1 text-xs text-primary-400">
                                        {row.device} · {row.type}
                                    </p>
                                </div>
                            ),
                        },
                        {
                            id: "usage",
                            sortValue: (row) => row.used,
                            label: "Used / capacity",
                            render: (row) => (
                                <ResourceUsage used={row.used} total={row.size} />
                            ),
                        },
                        {
                            id: "available",
                            sortValue: (row) => row.available,
                            label: "Available",
                            render: (row) => formatMetric(row.available, "bytes"),
                        },
                        {
                            id: "mode",
                            sortValue: (row) => row.readOnly,
                            label: "Access",
                            render: (row) =>
                                booleanLabel(row.readOnly, "Read only", "Read / write"),
                        },
                    ]}
                />
            </div>
        );
    if (section === "network")
        return (
            <div className="space-y-3">
                <Switch
                    label="Show virtual interfaces"
                    checked={virtual}
                    onChange={setVirtual}
                />
                <p className="text-sm text-primary-400">
                    Traffic is per interface; bridges and their member interfaces can
                    represent the same packets.
                </p>
                <DataTable
                    label={`${host.name} interfaces`}
                    compact
                    rows={inventory.networks.filter(
                        (row) => row.host === host.host && (virtual || !row.virtual)
                    )}
                    getKey={(row) => row.id}
                    columns={[
                        {
                            id: "device",
                            sortValue: (row) => row.device,
                            label: "Interface",
                            mobile: "title",
                            render: (row) => row.device,
                        },
                        {
                            id: "link",
                            sortValue: (row) => row.up,
                            label: "Link",
                            render: (row) => booleanLabel(row.up, "Up", "Down"),
                        },
                        {
                            id: "speed",
                            sortValue: (row) => row.speed,
                            label: "Link speed",
                            render: (row) =>
                                formatMetric(
                                    row.speed === null ? null : row.speed * 8,
                                    "bits/s"
                                ),
                        },
                        {
                            id: "receive",
                            sortValue: (row) => row.receive,
                            label: "Received",
                            render: (row) => formatMetric(row.receive, "bytes/s"),
                        },
                        {
                            id: "transmit",
                            sortValue: (row) => row.transmit,
                            label: "Sent",
                            render: (row) => formatMetric(row.transmit, "bytes/s"),
                        },
                        {
                            id: "errors",
                            sortValue: (row) => row.errors,
                            label: "Errors / drops per second",
                            render: (row) =>
                                `${formatMetric(row.errors)} / ${formatMetric(row.drops)}`,
                        },
                    ]}
                />
            </div>
        );
    return (
        <div className="space-y-3">
            <p className="text-sm text-primary-400">
                Block-device I/O, not free space. Partitions, logical volumes and physical
                disks can overlap.
            </p>
            <DataTable
                label={`${host.name} disk I/O`}
                compact
                rows={inventory.disks.filter((row) => row.host === host.host)}
                getKey={(row) => row.id}
                columns={[
                    {
                        id: "device",
                        sortValue: (row) => row.device,
                        label: "Device",
                        mobile: "title",
                        render: (row) => row.device,
                    },
                    {
                        id: "read",
                        sortValue: (row) => row.read,
                        label: "Read",
                        render: (row) => formatMetric(row.read, "bytes/s"),
                    },
                    {
                        id: "write",
                        sortValue: (row) => row.write,
                        label: "Written",
                        render: (row) => formatMetric(row.write, "bytes/s"),
                    },
                    {
                        id: "operations",
                        sortValue: (row) => row.operations,
                        label: "IOPS",
                        render: (row) => formatMetric(row.operations),
                    },
                    {
                        id: "busy",
                        sortValue: (row) => row.busyPercent,
                        label: "Busy",
                        render: (row) => formatMetric(row.busyPercent, "percent"),
                    },
                ]}
            />
        </div>
    );
}
