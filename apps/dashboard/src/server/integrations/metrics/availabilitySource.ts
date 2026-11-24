import type {
    AvailabilityKind,
    InfrastructureInventory,
} from "@homelab/contracts/infrastructure";

import { OperationFailure } from "../../operations/errors";

export interface AvailabilitySignal {
    readonly metric: string;
    readonly labels: Readonly<Record<string, string>>;
}
type Signal = AvailabilitySignal;

const up = (host: string, job: string): Signal => ({
    metric: "up",
    labels: { host, job },
});
const quote = JSON.stringify;

function selector({ metric, labels }: Signal) {
    return (
        metric +
        "{" +
        Object.entries(labels)
            .map(([name, value]) => name + "=" + quote(value))
            .join(",") +
        "}"
    );
}

// A missing minute, stale series or simultaneous duplicate identity contributes no observation.
function reading(source: Signal) {
    const last = `last_over_time(${selector(source)}[1m])`;
    return `(min(${last}) and (count(${last}) == 1))`;
}

function source(
    measure: string,
    signal: Signal,
    collector?: Signal,
    companions: readonly Signal[] = [],
    inverted = false
) {
    const main = reading(signal);
    const value = [
        inverted ? `(1 - ${main})` : main,
        ...companions.map((item) => reading(item)),
    ].join(" * ");
    return {
        measure,
        identity: selector(signal),
        value: collector ? `(${value}) and (${reading(collector)} == 1)` : value,
        signals: [signal, ...companions],
        guards: collector ? [collector] : [],
        inverted,
        freshness: null as Signal | null,
    };
}

/** Resolve an inventory selection to a measured health signal and its scrape-quality gates.
 * @param inventory - Latest server-owned resource identities.
 * @param kind - One of the monitored resource categories.
 * @param id - An opaque inventory key, never a browser-provided metric selector.
 * @returns Fixed monitor expressions and the specific condition being measured.
 */
export function availabilitySource(
    inventory: InfrastructureInventory,
    kind: AvailabilityKind,
    id: string
) {
    switch (kind) {
        case "host": {
            const row = inventory.hosts.find((item) => item.id === id);
            if (row?.guestId && row.pveInstance) {
                return source(
                    "Proxmox reports this resource running",
                    {
                        metric: "pve_up",
                        labels: { instance: row.pveInstance, id: row.guestId },
                    },
                    { metric: "up", labels: { instance: row.pveInstance, job: "pve" } }
                );
            }
            if (row?.host) return source("Node exporter reachable", up(row.host, "node"));
            break;
        }
        case "application": {
            const row = inventory.applications.find((item) => item.id === id);
            if (!row) break;
            const labels = { host: row.host, project: row.project, service: row.name };
            const app = (metric: string) => ({ metric: "homelab_app_" + metric, labels });
            const collector = (metric: string) =>
                reading({ metric: "homelab_app_" + metric, labels: { host: row.host } });
            const result = source(
                "Application present, running and ready",
                app("ready"),
                up(row.host, "node"),
                [app("present"), app("running")]
            );
            const age = `(time() - ${collector("last_run_timestamp_seconds")})`;
            return {
                ...result,
                guards: [
                    ...result.guards,
                    app("expected"),
                    {
                        metric: "homelab_app_collector_success",
                        labels: { host: row.host },
                    },
                ],
                freshness: {
                    metric: "homelab_app_last_run_timestamp_seconds",
                    labels: { host: row.host },
                },
                value: `(${result.value}) and (${reading(app("expected"))} == 1) and (${collector("collector_success")} == 1) and (${age} < 180) and (${age} >= -60)`,
            };
        }
        case "service": {
            const row = inventory.services.find((item) => item.id === id);
            if (!row) break;
            if (row.kind === "probe") {
                const labels = { check: row.name };
                return source(
                    "End-to-end check successful",
                    { metric: "probe_success", labels },
                    { metric: "up", labels }
                );
            }
            if (row.kind === "exporter") {
                const hash = JSON.parse(row.id) as string[];
                return {
                    ...source("Metrics exporter reachable", up(row.host, row.name)),
                    exporterHash: hash[3],
                    exporter: up(row.host, row.name),
                };
            }
            return source(
                "System service active",
                {
                    metric: "node_systemd_unit_state",
                    labels: { host: row.host, name: row.name, state: "active" },
                },
                up(row.host, "node")
            );
        }
        case "storage": {
            const row = inventory.storage.find((item) => item.id === id);
            if (!row) break;
            const [instance, resource] = JSON.parse(row.id) as string[];
            if (!instance || !resource) break;
            return source(
                "Proxmox storage pool available",
                { metric: "pve_up", labels: { instance, id: resource } },
                { metric: "up", labels: { instance, job: "pve" } }
            );
        }
        case "diskHealth": {
            const row = inventory.diskHealth.find((item) => item.id === id);
            if (!row) break;
            return source(
                "Disk passes SMART health checks",
                {
                    metric: "smartctl_device_smart_status",
                    labels: { host: row.host, device: row.device },
                },
                up(row.host, "smartctl")
            );
        }
        case "network": {
            const row = inventory.networks.find((item) => item.id === id);
            if (!row) break;
            return source(
                "Network interface link up",
                {
                    metric: "node_network_up",
                    labels: { host: row.host, device: row.device },
                },
                up(row.host, "node")
            );
        }
        case "filesystem": {
            const row = inventory.filesystems.find((item) => item.id === id);
            if (!row) break;
            const [, entity] = JSON.parse(row.id) as string[];
            if (
                row.device === "Home Assistant System Monitor" &&
                entity?.startsWith("sensor.system_monitor_disk_use_")
            ) {
                const sensor = (name: string) => ({
                    metric: "homeassistant_entity_available",
                    labels: { host: row.host, entity: name },
                });
                return source(
                    "Both capacity sensors available",
                    sensor(entity),
                    up(row.host, "homeassistant"),
                    [sensor(entity.replace("_use_", "_free_"))]
                );
            }
            return source(
                "Filesystem statistics readable",
                {
                    metric: "node_filesystem_device_error",
                    labels: {
                        host: row.host,
                        device: row.device,
                        mountpoint: row.mount,
                        fstype: row.type,
                    },
                },
                up(row.host, "node"),
                [],
                true
            );
        }
    }
    throw new OperationFailure(
        "NOT_FOUND",
        "This resource is not in the latest monitoring inventory."
    );
}

/** Bind an exporter query to the original scrape instance after matching the saved identity hash.
 * @param candidate - Inventory-derived host and job labels for this exporter.
 * @param instance - The original instance label returned by the monitoring backend.
 * @returns A query that cannot mix multiple monitored targets sharing a host and job.
 */
export function exporterSource(candidate: Signal, instance: string) {
    return source("Metrics exporter reachable", {
        ...candidate,
        labels: { ...candidate.labels, instance },
    });
}
