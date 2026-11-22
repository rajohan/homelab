import type {
    DiskHealthMetric,
    StoragePoolMetric,
} from "@homelab/contracts/infrastructure";
import { DetailEntry, DetailFacts, DetailList, formatMetric } from "@homelab/ui";
import { HeartPulse } from "lucide-react";

import { ResourceStatus } from "./ResourceStatus";
import { StoragePools } from "./StoragePools";

/**
 * Keep logical pool capacity and physical disk health separate to avoid double-counting storage.
 * @returns PVE storage and SMART health as responsive resource lists.
 */
export function StorageInventory({
    pools,
    disks,
}: {
    readonly pools: readonly StoragePoolMetric[];
    readonly disks: readonly DiskHealthMetric[];
}) {
    return (
        <div className="space-y-4">
            <StoragePools pools={pools} />
            <DetailList
                icon={HeartPulse}
                title="Physical disk health"
                rows={disks}
                getKey={(row) => row.id}
                showSort={false}
                sorts={[{ label: "Disk", value: (row) => `${row.host} ${row.device}` }]}
                empty="No physical disk health reported."
                render={(row) => (
                    <DetailEntry
                        name={row.device}
                        description={row.host}
                        accessory={<ResourceStatus state={row.state} />}
                    >
                        <DetailFacts
                            inline
                            items={[
                                {
                                    label: "Temperature",
                                    value: formatMetric(row.temperature, "celsius"),
                                },
                                {
                                    label: "Endurance used",
                                    value: formatMetric(row.wearPercent, "percent"),
                                },
                            ]}
                        />
                    </DetailEntry>
                )}
            />
        </div>
    );
}
