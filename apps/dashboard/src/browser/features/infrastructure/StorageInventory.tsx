import type {
    DiskHealthMetric,
    StoragePoolMetric,
} from "@homelab/contracts/infrastructure";
import { Card, DataTable, SectionHeader, formatMetric } from "@homelab/ui";
import { HardDrive } from "lucide-react";

import { ResourceStatus } from "./ResourceStatus";
import { ResourceUsage } from "./ResourceUsage";

/**
 * Keep logical pool capacity and physical disk health separate to avoid double-counting storage.
 * @returns PVE storage and SMART health in bounded responsive tables.
 */
export function StorageInventory({
    pools,
    disks,
}: {
    readonly pools: readonly StoragePoolMetric[];
    readonly disks: readonly DiskHealthMetric[];
}) {
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Storage"
                description="Pools may share disks or datasets. Their capacities are not added together."
                icon={HardDrive}
            />
            <DataTable
                label="Storage pools"
                compact
                rows={pools}
                getKey={(row) => row.id}
                columns={[
                    {
                        id: "name",
                        sortValue: (row) => row.name,
                        label: "Pool",
                        mobile: "title",
                        render: (row) => (
                            <div className="font-semibold">
                                {row.name}
                                <p className="mt-1 text-xs font-normal text-primary-400">
                                    {row.node} · {row.type}
                                </p>
                            </div>
                        ),
                    },
                    {
                        id: "state",
                        sortValue: (row) => row.state,
                        label: "Status",
                        render: (row) => <ResourceStatus state={row.state} />,
                    },
                    {
                        id: "capacity",
                        sortValue: (row) => row.used,
                        label: "Used / capacity",
                        render: (row) => (
                            <ResourceUsage used={row.used} total={row.size} />
                        ),
                    },
                ]}
            />
            <h3 className="text-sm font-semibold text-primary-200">
                Physical disk health
            </h3>
            <DataTable
                label="Physical disk health"
                compact
                rows={disks}
                getKey={(row) => row.id}
                columns={[
                    {
                        id: "name",
                        sortValue: (row) => `${row.host} ${row.device}`,
                        label: "Disk",
                        mobile: "title",
                        render: (row) => `${row.host} · ${row.device}`,
                    },
                    {
                        id: "state",
                        sortValue: (row) => row.state,
                        label: "SMART",
                        render: (row) => <ResourceStatus state={row.state} />,
                    },
                    {
                        id: "temperature",
                        sortValue: (row) => row.temperature,
                        label: "Temperature",
                        render: (row) => formatMetric(row.temperature, "celsius"),
                    },
                    {
                        id: "wear",
                        sortValue: (row) => row.wearPercent,
                        label: "Endurance used",
                        render: (row) => formatMetric(row.wearPercent, "percent"),
                    },
                ]}
            />
            {pools.length === 0 && disks.length === 0 && (
                <p className="text-sm text-primary-400">
                    Storage metrics have not been reported.
                </p>
            )}
        </Card>
    );
}
