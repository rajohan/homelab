import type {
    InfrastructureHost,
    InfrastructureInventory,
} from "@homelab/contracts/infrastructure";

/** Scope the resource lists and their section destinations to the selected host.
 * @param host - The inspected physical machine or guest.
 * @param inventory - The latest observed infrastructure inventory.
 * @param prefix - The dialog's unique anchor prefix.
 * @returns Resource rows and the same visible sections used by the header and detail panels.
 */
export function hostInventorySections(
    host: InfrastructureHost,
    inventory: InfrastructureInventory,
    prefix: string
) {
    const filesystems = inventory.filesystems.filter((row) => row.host === host.host);
    const pools =
        host.kind === "node"
            ? inventory.storage.filter((row) => row.node === (host.node ?? host.name))
            : [];
    const networks = inventory.networks.filter((row) => row.host === host.host);
    const disks = inventory.disks.filter((row) => row.host === host.host);
    const sections = {
        usage: { label: "Resource usage", value: prefix + "-usage", visible: true },
        availability: {
            label: "Availability",
            value: prefix + "-availability",
            visible: true,
        },
        history: { label: "Resource history", value: prefix + "-history", visible: true },
        mounts: {
            label: "Filesystems",
            value: prefix + "-mounts",
            visible: host.guestMetricsAvailable || filesystems.length > 0,
        },
        pools: {
            label: "Storage pools",
            value: prefix + "-pools",
            visible: pools.length > 0,
        },
        applications: {
            label: "Applications",
            value: prefix + "-applications",
            visible: true,
        },
        network: {
            label: "Network interfaces",
            value: prefix + "-network",
            visible: host.guestMetricsAvailable || networks.length > 0,
        },
        disks: {
            label: "Disk I/O",
            value: prefix + "-disks",
            visible: host.guestMetricsAvailable || disks.length > 0,
        },
    };
    return { filesystems, pools, networks, disks, sections };
}
