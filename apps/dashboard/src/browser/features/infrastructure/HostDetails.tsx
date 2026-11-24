import type {
    InfrastructureHost,
    InfrastructureInventory,
} from "@homelab/contracts/infrastructure";
import { DetailSection, formatDateTime, Modal, SectionJumpMenu } from "@homelab/ui";
import { Gauge, History, Server } from "lucide-react";
import { useId, useRef } from "react";

import { AvailabilityReadings } from "./AvailabilityReadings";
import { hostInventorySections } from "./hostInventorySections";
import { HostReadings } from "./HostReadings";
import { HostResources } from "./HostResources";
import { ResourceStatus } from "./ResourceStatus";

/**
 * Open one host's resource details without expanding the inventory table or fetching all histories.
 * @returns A focus-managed resource dialog sharing the application's modal layout.
 */
export function HostDetails({
    host,
    inventory,
    onClose,
    stale = false,
}: {
    readonly host: InfrastructureHost;
    readonly inventory: InfrastructureInventory;
    readonly stale?: boolean;
    readonly onClose: () => void;
}) {
    const prefix = useId();
    const scrollRef = useRef<HTMLElement>(null);
    const scoped = hostInventorySections(host, inventory, prefix);
    const options = Object.values(scoped.sections).filter((section) => section.visible);
    const kind = {
        node: "Proxmox node",
        host: "Physical host",
        vm: "Virtual machine",
        container: "Container",
    }[host.kind];
    const identity = [
        kind,
        host.guestId,
        host.node && host.node !== host.name ? host.node : undefined,
    ]
        .filter(Boolean)
        .join(" · ");
    return (
        <Modal
            icon={Server}
            title={host.name}
            titleAccessory={<ResourceStatus state={stale ? "unknown" : host.state} />}
            description={identity}
            contentRef={scrollRef}
            navigation={
                <SectionJumpMenu
                    label="Jump to host section"
                    scrollRef={scrollRef}
                    sections={options}
                />
            }
            onClose={onClose}
            size="wide"
        >
            <div className="space-y-5">
                {stale && (
                    <p className="text-sm text-amber-300">
                        Last observation {formatDateTime(inventory.capturedAt)} · Current
                        readings unavailable
                    </p>
                )}
                <DetailSection
                    icon={Gauge}
                    title="Resource usage"
                    anchor={scoped.sections.usage.value}
                >
                    <HostReadings
                        detailed
                        host={host}
                        filesystems={inventory.filesystems}
                        stale={stale}
                    />
                </DetailSection>
                <DetailSection
                    icon={History}
                    title="Availability"
                    anchor={scoped.sections.availability.value}
                >
                    <AvailabilityReadings kind="host" id={host.id} />
                </DetailSection>
                <HostResources
                    scoped={scoped}
                    host={host}
                    inventory={inventory}
                    stale={stale}
                />
            </div>
        </Modal>
    );
}
