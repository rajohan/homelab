import type {
    InfrastructureHost,
    InfrastructureInventory,
} from "@homelab/contracts/infrastructure";
import { Modal, Select, formatMetric } from "@homelab/ui";
import { useState } from "react";

import { HostHistory } from "./HostHistory";
import { HostResources } from "./HostResources";
import { MetricStat } from "./MetricStat";
import { ResourceStatus } from "./ResourceStatus";

/**
 * Open one host's resource details without expanding the inventory table or fetching all histories.
 * @returns A focus-managed resource dialog sharing the application's modal layout.
 */
export function HostDetails({
    host,
    inventory,
    onClose,
}: {
    readonly host: InfrastructureHost;
    readonly inventory: InfrastructureInventory;
    readonly onClose: () => void;
}) {
    const [section, setSection] = useState("history");
    return (
        <Modal
            title={host.name}
            titleAccessory={<ResourceStatus state={host.state} />}
            description={`${host.guestId ?? host.kind}${host.node ? ` · ${host.node}` : ""}`}
            onClose={onClose}
            size="wide"
        >
            <div className="space-y-5">
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <MetricStat
                        label="CPU"
                        value={formatMetric(host.cpuPercent, "percent")}
                        detail={`${host.cores ?? "Unknown"} cores`}
                    />
                    <MetricStat
                        label="Memory used"
                        value={formatMetric(host.memoryUsed, "bytes")}
                        detail={
                            host.memorySource === "guest"
                                ? "OS total minus available"
                                : "Hypervisor reported"
                        }
                    />
                    <MetricStat
                        label="Assigned memory"
                        value={formatMetric(host.allocatedMemory, "bytes")}
                        detail={`${host.memorySource === "guest" ? "OS total" : "Reported capacity"}: ${formatMetric(host.memoryTotal, "bytes")}`}
                    />
                    <MetricStat
                        label="Uptime"
                        value={formatMetric(host.uptime, "seconds")}
                    />
                    <MetricStat
                        label="Swap used"
                        value={formatMetric(host.swapUsed, "bytes")}
                        detail={`Total: ${formatMetric(host.swapTotal, "bytes")}`}
                    />
                    <MetricStat
                        label="Load average"
                        value={host.load
                            .map((value) => (value === null ? "—" : formatMetric(value)))
                            .join(" / ")}
                        detail="1 / 5 / 15 minutes"
                    />
                </dl>
                <Select
                    label="Resource details"
                    value={section}
                    onChange={setSection}
                    options={[
                        { value: "history", label: "History" },
                        { value: "filesystems", label: "Filesystems" },
                        { value: "network", label: "Network interfaces" },
                        { value: "disks", label: "Disk I/O" },
                        { value: "applications", label: "Applications" },
                    ]}
                />
                {section === "history" ? (
                    <HostHistory host={host} inventory={inventory} />
                ) : (
                    <HostResources host={host} inventory={inventory} section={section} />
                )}
            </div>
        </Modal>
    );
}
