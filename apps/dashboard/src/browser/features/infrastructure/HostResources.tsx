import type {
    InfrastructureHost,
    InfrastructureInventory,
} from "@homelab/contracts/infrastructure";
import { DetailEntry, DetailFacts, DetailList, formatMetric, Switch } from "@homelab/ui";
import { FolderTree, HardDrive, Network } from "lucide-react";
import { useState } from "react";

import { HostApplications } from "./HostApplications";
import { HostHistory } from "./HostHistory";
import type { hostInventorySections } from "./hostInventorySections";
import { ResourceUsage } from "./ResourceUsage";
import { StoragePools } from "./StoragePools";

function booleanLabel(value: boolean | null, yes: string, no: string): string {
    if (value === null) return "Unknown";
    return value ? yes : no;
}

/** Keep each host's mounted capacity, storage pools and device measurements in a single scrollable view.
 * @returns Independently sortable inventories with their original measured units.
 */
export function HostResources({
    host,
    inventory,
    scoped,
    stale,
}: {
    readonly host: InfrastructureHost;
    readonly inventory: InfrastructureInventory;
    readonly scoped: ReturnType<typeof hostInventorySections>;
    readonly stale: boolean;
}) {
    const [virtual, setVirtual] = useState(false);
    const { filesystems, pools, networks, disks, sections } = scoped;
    return (
        <>
            <HostHistory
                host={host}
                inventory={inventory}
                anchor={sections.history.value}
            />
            {!host.guestMetricsAvailable && (
                <p className="text-sm leading-relaxed text-primary-400">
                    Guest measurements are unavailable. Check the guest exporter for
                    current filesystem, network and disk readings.
                </p>
            )}
            {sections.mounts.visible && (
                <DetailList
                    icon={FolderTree}
                    title="Filesystems"
                    anchor={sections.mounts.value}
                    rows={filesystems}
                    getKey={(row) => row.id}
                    description={
                        filesystems.some((row) => row.type === "zfs")
                            ? "ZFS datasets can share free space."
                            : undefined
                    }
                    empty="No mounts reported for this host."
                    sorts={[
                        { label: "Mount", value: (row) => row.mount },
                        { label: "Used", value: (row) => row.used },
                        { label: "Available", value: (row) => row.available },
                        { label: "Access", value: (row) => row.readOnly },
                    ]}
                    render={(row) => (
                        <DetailEntry
                            name={row.mount}
                            description={`${row.device} · ${row.type} · ${booleanLabel(row.readOnly, "Read only", "Read / write")}`}
                        >
                            <ResourceUsage
                                used={row.used}
                                total={row.size}
                                description={`${formatMetric(row.available, "bytes")} available`}
                            />
                        </DetailEntry>
                    )}
                />
            )}
            {sections.pools.visible && (
                <StoragePools pools={pools} anchor={sections.pools.value} />
            )}
            <HostApplications
                capturedAt={inventory.capturedAt}
                cores={host.cores}
                anchor={sections.applications.value}
                applications={inventory.applications.filter(
                    (row) => row.host === host.host
                )}
                stale={stale}
            />
            {sections.network.visible && (
                <DetailList
                    icon={Network}
                    title="Network interfaces"
                    anchor={sections.network.value}
                    rows={networks.filter((row) => virtual || !row.virtual)}
                    getKey={(row) => row.id}
                    empty="No matching interfaces reported."
                    description="Bridges and their member interfaces can carry the same traffic."
                    actions={
                        <Switch
                            label="Show virtual interfaces"
                            checked={virtual}
                            onChange={setVirtual}
                        />
                    }
                    sorts={[
                        { label: "Interface", value: (row) => row.device },
                        { label: "Link", value: (row) => row.up },
                        { label: "Link speed", value: (row) => row.speed },
                        { label: "Received", value: (row) => row.receive },
                        { label: "Sent", value: (row) => row.transmit },
                        { label: "Errors", value: (row) => row.errors },
                        { label: "Drops", value: (row) => row.drops },
                    ]}
                    render={(row) => (
                        <DetailEntry
                            name={row.device}
                            description={`${booleanLabel(row.up, "Link up", "Link down")} · ${formatMetric(row.speed === null ? null : row.speed * 8, "bits/s")}`}
                        >
                            <DetailFacts
                                items={[
                                    {
                                        label: "Received",
                                        value: formatMetric(row.receive, "bytes/s"),
                                    },
                                    {
                                        label: "Sent",
                                        value: formatMetric(row.transmit, "bytes/s"),
                                    },
                                    {
                                        label: "Errors / drops per sec",
                                        value: `${formatMetric(row.errors)} / ${formatMetric(row.drops)}`,
                                    },
                                ]}
                            />
                        </DetailEntry>
                    )}
                />
            )}
            {sections.disks.visible && (
                <DetailList
                    icon={HardDrive}
                    title="Disk I/O"
                    anchor={sections.disks.value}
                    rows={disks}
                    getKey={(row) => row.id}
                    description="Partitions, logical volumes and physical disks can overlap."
                    empty="No block devices reported."
                    sorts={[
                        { label: "Device", value: (row) => row.device },
                        { label: "Read", value: (row) => row.read },
                        { label: "Written", value: (row) => row.write },
                        { label: "IOPS", value: (row) => row.operations },
                        { label: "Busy", value: (row) => row.busyPercent },
                    ]}
                    render={(row) => (
                        <DetailEntry
                            name={row.device}
                            description={`${formatMetric(row.busyPercent, "percent")} busy`}
                        >
                            <DetailFacts
                                items={[
                                    {
                                        label: "Read",
                                        value: formatMetric(row.read, "bytes/s"),
                                    },
                                    {
                                        label: "Written",
                                        value: formatMetric(row.write, "bytes/s"),
                                    },
                                    {
                                        label: "IOPS",
                                        value: formatMetric(row.operations),
                                    },
                                ]}
                            />
                        </DetailEntry>
                    )}
                />
            )}
        </>
    );
}
