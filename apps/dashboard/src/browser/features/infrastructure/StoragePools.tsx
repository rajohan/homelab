import type { StoragePoolMetric } from "@homelab/contracts/infrastructure";
import { DetailEntry, DetailList } from "@homelab/ui";
import { Database } from "lucide-react";

import { ResourceStatus } from "./ResourceStatus";
import { ResourceUsage } from "./ResourceUsage";

/** Show independently measured pool capacity, status and node for a host or the whole inventory.
 * @returns A name-ordered list of storage pools with measured capacity bars.
 */
export function StoragePools({
    pools,
    anchor,
}: {
    readonly pools: readonly StoragePoolMetric[];
    readonly anchor?: string;
}) {
    return (
        <DetailList
            icon={Database}
            title="Storage pools"
            anchor={anchor}
            rows={pools}
            getKey={(row) => row.id}
            empty="No storage pools reported."
            showSort={false}
            sorts={[{ label: "Pool", value: (row) => row.name }]}
            render={(row) => (
                <DetailEntry
                    name={row.name}
                    description={`${row.node} · ${row.type}`}
                    accessory={<ResourceStatus state={row.state} />}
                >
                    <ResourceUsage used={row.used} total={row.size} />
                </DetailEntry>
            )}
        />
    );
}
