import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";

import {
    applicationInventoryAvailable,
    resourceKey,
    type MetricSamples,
} from "./samples";

function retainRows<T extends { readonly id: string }>(
    current: readonly T[],
    previous: readonly T[],
    unavailable: (row: T) => boolean,
    clear: (row: T) => T
): T[] {
    const rows = new Map(current.map((row) => [row.id, row]));
    for (const row of previous) if (unavailable(row)) rows.set(row.id, clear(row));
    return [...rows.values()];
}

/**
 * Preserve known resource identities while their source is explicitly unavailable.
 * Host identities are joined separately before calculating independent guest telemetry.
 * @param current - Newly collected rows; healthy sources remain authoritative for deletions.
 * @param previous - The last successful live or persisted inventory, if available.
 * @param samples - Current scrape status and application collector health.
 * @returns A current inventory with unavailable resources retained without old measurements.
 */
export function retainUnavailableInventory(
    current: InfrastructureInventory,
    previous: InfrastructureInventory | null | undefined,
    samples: MetricSamples
): InfrastructureInventory {
    if (!previous) return current;
    const down = (job: string, label: string) =>
        new Set(
            (samples.up ?? []).flatMap((sample) => {
                const value = sample.labels[label];
                return sample.labels.job === job && sample.value !== 1 && value
                    ? [value]
                    : [];
            })
        );
    const pve = down("pve", "instance");
    const node = down("node", "host");
    const homeAssistant = down("homeassistant", "host");
    const smart = down("smartctl", "host");
    const probes = new Set(
        (samples.up ?? []).flatMap((sample) =>
            sample.value !== 1 && sample.labels.check ? [sample.labels.check] : []
        )
    );
    const monitoredHosts = new Set(
        (samples.up ?? []).flatMap((sample) =>
            sample.labels.job === "node" && sample.labels.host ? [sample.labels.host] : []
        )
    );
    return {
        ...current,
        storage: retainRows(
            current.storage,
            previous.storage,
            // Pool IDs are resourceKey(instance, id); match the escaped first part, not a node name.
            (row) =>
                [...pve].some((instance) =>
                    row.id.startsWith(`[${JSON.stringify(instance)},`)
                ),
            (row) => ({ ...row, state: "unknown", size: null, used: null })
        ),
        applications: retainRows(
            current.applications,
            previous.applications,
            (row) =>
                monitoredHosts.has(row.host) &&
                !applicationInventoryAvailable(samples, row.host),
            (row) => {
                const { resources: _resources, ...identity } = row;
                return { ...identity, state: "unknown", restarts: null, startedAt: null };
            }
        ),
        filesystems: retainRows(
            current.filesystems,
            previous.filesystems,
            (row) =>
                row.id === resourceKey(row.host, row.device, row.mount)
                    ? node.has(row.host)
                    : homeAssistant.has(row.host),
            (row) => ({ ...row, size: null, used: null, available: null, readOnly: null })
        ),
        networks: retainRows(
            current.networks,
            previous.networks,
            (row) => node.has(row.host),
            (row) => ({
                ...row,
                up: null,
                speed: null,
                receive: null,
                transmit: null,
                errors: null,
                drops: null,
            })
        ),
        disks: retainRows(
            current.disks,
            previous.disks,
            (row) => node.has(row.host),
            (row) => ({
                ...row,
                read: null,
                write: null,
                operations: null,
                busyPercent: null,
            })
        ),
        services: retainRows(
            current.services,
            previous.services,
            (row) =>
                (row.kind === "service" && node.has(row.host)) ||
                (row.kind === "probe" && probes.has(row.name)),
            (row) => ({ ...row, state: "unknown" })
        ),
        diskHealth: retainRows(
            current.diskHealth,
            previous.diskHealth,
            (row) => smart.has(row.host),
            (row) => ({ ...row, state: "unknown", temperature: null, wearPercent: null })
        ),
    };
}
