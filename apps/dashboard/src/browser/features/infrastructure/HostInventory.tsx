import type {
    FilesystemMetric,
    InfrastructureHost,
} from "@homelab/contracts/infrastructure";
import { compareTableValues } from "@homelab/contracts/tableSort";
import { GroupedDirectory, SectionPanel, SummaryStrip } from "@homelab/ui";
import { Server } from "lucide-react";

import { HostReadings } from "./HostReadings";
import { HostShelf } from "./HostShelf";
import { ResourceStatus } from "./ResourceStatus";

const memoryLabels = {
    guest: "Inside guest / OS",
    hypervisor: "Hypervisor reported",
    unavailable: "Not reported",
};

/**
 * Show every hypervisor, guest and additional monitored host with explicit resource sources.
 * @returns Host and guest counts, name-ordered resource readings and access to host details.
 */
export function HostInventory({
    hosts,
    filesystems,
    onSelect,
    stale,
}: {
    readonly stale: boolean;
    readonly hosts: readonly InfrastructureHost[];
    readonly filesystems: readonly FilesystemMetric[];
    readonly onSelect: (host: InfrastructureHost) => void;
}) {
    const rows = hosts.toSorted((a, b) =>
        compareTableValues(a.name, b.name, "ascending")
    );
    const vms = hosts.filter((host) => host.kind === "vm").length;
    const containers = hosts.filter((host) => host.kind === "container").length;
    return (
        <SectionPanel
            title="Hosts and guests"
            description="Select a host for resource history, interfaces, disks and filesystems."
            icon={Server}
        >
            <SummaryStrip
                label="Host and guest counts"
                items={[
                    { label: "Hosts", value: hosts.length - vms - containers },
                    { label: "VMs", value: vms },
                    { label: "Containers", value: containers },
                ]}
            />
            {rows.length > 0 ? (
                <div className="space-y-5 pt-2 sm:pt-3">
                    <HostShelf
                        compact
                        filesystems={filesystems}
                        hosts={rows.filter(
                            (host) => host.kind === "node" || host.kind === "host"
                        )}
                        stale={stale}
                        onSelect={onSelect}
                    />
                    <GroupedDirectory
                        ordered
                        items={rows.filter(
                            (host) => host.kind !== "node" && host.kind !== "host"
                        )}
                        group={(host) =>
                            host.node
                                ? `Guests on ${host.node}`
                                : "Guests without a reported node"
                        }
                        getKey={(host) => host.id}
                        name={(host) => host.name}
                        detail={(host) =>
                            [
                                `${host.kind === "vm" ? "VM" : "Container"} ${host.guestId ?? ""}`.trim(),
                                memoryLabels[host.memorySource],
                            ].join(" · ")
                        }
                        readings={(host) => (
                            <HostReadings
                                host={host}
                                filesystems={filesystems}
                                stale={stale}
                            />
                        )}
                        status={(host) => (
                            <ResourceStatus state={stale ? "unknown" : host.state} />
                        )}
                        onSelect={onSelect}
                    />
                </div>
            ) : (
                <p className="text-sm text-primary-400">No hosts or guests reported.</p>
            )}
        </SectionPanel>
    );
}
