import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";
import { useState } from "react";

import { ApplicationInventory } from "./ApplicationInventory";
import { HostDetails } from "./HostDetails";
import { HostInventory } from "./HostInventory";
import { MetricStat } from "./MetricStat";
import { ServiceInventory } from "./ServiceInventory";
import { StorageInventory } from "./StorageInventory";

/**
 * Present one coherent infrastructure snapshot with resource summaries and scoped details.
 * @returns Read-only host, storage, application and service visibility.
 */
export function InfrastructureOverview({
    inventory,
}: {
    readonly inventory: InfrastructureInventory;
}) {
    const [selected, setSelected] = useState<string | null>(null);
    const host = inventory.hosts.find((item) => item.id === selected);
    const guests = inventory.hosts.filter(
        (item) => item.kind === "vm" || item.kind === "container"
    );
    return (
        <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <MetricStat
                    label="PVE guests"
                    value={guests.length}
                    detail={`${guests.filter((item) => item.kind === "vm").length} virtual machines · ${guests.filter((item) => item.kind === "container").length} containers`}
                />
                <MetricStat
                    label="Hosts and nodes"
                    value={inventory.hosts.length - guests.length}
                    detail="Hypervisors and additional hosts"
                />
                <MetricStat
                    label="Applications"
                    value={`${inventory.applications.filter((item) => item.state === "healthy").length} / ${inventory.applications.length}`}
                    detail="Reported healthy / expected"
                />
                <MetricStat
                    label="Needs attention"
                    value={
                        inventory.applications.filter(
                            (item) => item.state === "unhealthy"
                        ).length +
                        inventory.services.filter(
                            (item) => item.kind === "probe" && item.state === "unhealthy"
                        ).length
                    }
                    detail={`${inventory.applications.filter((item) => item.state === "unknown").length} applications with unknown state`}
                />
            </dl>
            <HostInventory
                hosts={inventory.hosts}
                filesystems={inventory.filesystems}
                onSelect={(item) => setSelected(item.id)}
            />
            <StorageInventory pools={inventory.storage} disks={inventory.diskHealth} />
            <ApplicationInventory applications={inventory.applications} />
            <ServiceInventory services={inventory.services} />
            {host && (
                <HostDetails
                    key={host.id}
                    host={host}
                    inventory={inventory}
                    onClose={() => setSelected(null)}
                />
            )}
        </div>
    );
}
