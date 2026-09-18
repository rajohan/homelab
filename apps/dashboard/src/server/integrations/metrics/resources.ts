import type {
    ApplicationMetric,
    DiskHealthMetric,
    DiskMetric,
    FilesystemMetric,
    NetworkMetric,
    ServiceMetric,
    StoragePoolMetric,
} from "@homelab/contracts/infrastructure";

import { effectiveMemoryCapacity } from "./memory";
import {
    exporterAvailable,
    measurement,
    resourceKey,
    resourceState,
    type MetricSamples,
} from "./samples";

/**
 * Collect capacity, network and I/O per device without summing overlapping mounts or bridges.
 * @param samples - The validated monitoring inventory.
 * @returns Resource rows, with unavailable exporters represented by null measurements.
 */
export function buildResources(samples: MetricSamples) {
    const filesystems: FilesystemMetric[] = [];
    const networks: NetworkMetric[] = [];
    const disks: DiskMetric[] = [];
    for (const sample of samples.node_filesystem_size_bytes ?? []) {
        const { host, device, mountpoint: mount, fstype: type } = sample.labels;
        if (
            !host ||
            !device ||
            !mount ||
            !type ||
            /^(tmpfs|devtmpfs|overlay|squashfs|fuse\.)/.test(type) ||
            /^\/(run|proc|sys|dev)(\/|$)/.test(mount)
        )
            continue;
        const labels = { host, device, mountpoint: mount, fstype: type };
        const healthy =
            exporterAvailable(samples, host, "node") &&
            measurement(samples, "node_filesystem_device_error", labels) !== 1;
        const value = (name: string) =>
            healthy ? measurement(samples, name, labels) : null;
        const size = value("node_filesystem_size_bytes");
        const free = value("node_filesystem_free_bytes");
        const readOnly = value("node_filesystem_readonly");
        filesystems.push({
            id: resourceKey(host, device, mount),
            host,
            device,
            mount,
            type,
            size,
            used: size !== null && free !== null ? Math.max(0, size - free) : null,
            available: value("node_filesystem_avail_bytes"),
            readOnly: readOnly === null ? null : readOnly === 1,
        });
    }
    for (const sample of samples.receive ?? []) {
        const { host, device } = sample.labels;
        if (!host || !device || device === "lo") continue;
        const labels = { host, device };
        const value = (name: string) =>
            exporterAvailable(samples, host, "node")
                ? measurement(samples, name, labels)
                : null;
        const up = value("node_network_up");
        const speed = value("node_network_speed_bytes");
        networks.push({
            id: resourceKey(host, device),
            host,
            device,
            virtual: /^(veth|tap|fw|br|docker|vmbr|virbr|tun|wg)/.test(device),
            up: up === null ? null : up === 1,
            speed: speed !== null && speed < 1e14 ? speed : null,
            receive: value("receive"),
            transmit: value("transmit"),
            errors: value("errors"),
            drops: value("drops"),
        });
    }
    for (const sample of samples.read ?? []) {
        const { host, device } = sample.labels;
        if (!host || !device || /^(loop|ram)/.test(device)) continue;
        const value = (name: string) =>
            exporterAvailable(samples, host, "node")
                ? measurement(samples, name, { host, device })
                : null;
        disks.push({
            id: resourceKey(host, device),
            host,
            device,
            read: value("read"),
            write: value("write"),
            operations: value("operations"),
            busyPercent: value("busy"),
        });
    }
    return { filesystems, networks, disks };
}

/**
 * Describe each PVE storage endpoint independently; datasets may share underlying capacity.
 * @param samples - The validated monitoring inventory.
 * @returns Pool capacity and reachability without fabricated aggregate free space.
 */
export function buildStorage(samples: MetricSamples): StoragePoolMetric[] {
    return (samples.pve_storage_info ?? []).flatMap((sample) => {
        const { host, instance, id, storage, node, plugintype } = sample.labels;
        if (!host || !instance || !id || !storage || !node) return [];
        const value = (name: string) =>
            exporterAvailable(samples, host, "pve")
                ? measurement(samples, name, { instance, id })
                : null;
        const up = value("pve_up");
        return [
            {
                id: resourceKey(instance, id),
                name: storage,
                node,
                type: plugintype ?? "Unknown",
                state: resourceState(up),
                size: value("pve_disk_size_bytes"),
                used: value("pve_disk_usage_bytes"),
            },
        ];
    });
}

/**
 * Interpret expected application state only while its host and inventory collector are healthy.
 * @param samples - The validated monitoring inventory.
 * @param now - Collection time in seconds, injectable for boundary tests.
 * @returns Expected applications including missing, stopped and stale resources.
 */
export function buildApplications(
    samples: MetricSamples,
    now = Date.now() / 1000
): ApplicationMetric[] {
    return (samples.homelab_app_expected ?? []).flatMap((sample) => {
        const { host, project, service } = sample.labels;
        if (!host || !project || !service || sample.value !== 1) return [];
        const labels = { host, project, service };
        const timestamp = measurement(samples, "homelab_app_last_run_timestamp_seconds", {
            host,
        });
        const fresh =
            exporterAvailable(samples, host, "node") &&
            measurement(samples, "homelab_app_collector_success", { host }) === 1 &&
            timestamp !== null &&
            now - timestamp < 180 &&
            timestamp <= now + 60;
        const value = (name: string) =>
            fresh ? measurement(samples, name, labels) : null;
        const ready = value("homelab_app_ready");
        const present = value("homelab_app_present");
        const running = value("homelab_app_running");
        const resourceSource =
            measurement(samples, "homelab_native_app_info", labels) === 1
                ? "native"
                : "container";
        const prefix = `homelab_${resourceSource}_`;
        const sampledAt = value(`${prefix}last_sample_timestamp_seconds`);
        const resources =
            running === 1 &&
            sampledAt !== null &&
            now - sampledAt < 180 &&
            sampledAt <= now + 60 &&
            value(`${prefix}metrics_success`) === 1
                ? {
                      sampledAt,
                      cpuPercent: value(`${resourceSource}Cpu`),
                      memoryUsed: value(`${prefix}memory_working_set_bytes`),
                      memoryLimit: value(`${prefix}memory_limit_bytes`),
                      memoryCapacity: effectiveMemoryCapacity(
                          value(`${prefix}memory_limit_bytes`),
                          measurement(samples, "node_memory_MemTotal_bytes", { host })
                      ),
                      pids: value(`${prefix}pids`),
                      networkShared: value(`${prefix}network_shared`) === 1,
                      receive: value(`${resourceSource}Receive`),
                      transmit: value(`${resourceSource}Transmit`),
                      read: value(`${resourceSource}Read`),
                      write: value(`${resourceSource}Write`),
                  }
                : undefined;
        return [
            {
                id: resourceKey(host, project, service),
                host,
                project,
                name: service,
                resourceSource,
                state: resourceState(
                    !fresh || ready === null || present === null || running === null
                        ? null
                        : Math.min(present, running, ready)
                ),
                restarts: value("homelab_app_restart_count"),
                startedAt: value("homelab_app_start_timestamp_seconds"),
                healthcheck: value("homelab_app_healthcheck_present") === 1,
                ...(resources ? { resources } : {}),
            },
        ];
    });
}

/**
 * Separate external service checks from exporter availability and native unit state.
 * @param samples - The validated monitoring inventory.
 * @returns Only reviewed labels, never target URLs or arbitrary scrape metadata.
 */
export function buildServices(samples: MetricSamples): ServiceMetric[] {
    const result: ServiceMetric[] = [];
    for (const sample of samples.probe_success ?? []) {
        const name = sample.labels.check;
        if (!name) continue;
        const scraped = measurement(samples, "up", { check: name });
        result.push({
            id: resourceKey("probe", name),
            host: sample.labels.host ?? sample.labels.component ?? "External",
            name,
            kind: "probe",
            state: resourceState(scraped === 1 ? sample.value : null),
        });
    }
    for (const sample of samples.up ?? []) {
        const { host, job, instance } = sample.labels;
        if (!host || !job || job === "probe") continue;
        result.push({
            id: resourceKey(
                "exporter",
                host,
                job,
                new Bun.CryptoHasher("sha256")
                    .update(instance ?? "")
                    .digest("hex")
                    .slice(0, 16)
            ),
            host,
            name: job,
            kind: "exporter",
            state: resourceState(sample.value),
        });
    }
    for (const sample of samples.node_systemd_unit_state ?? []) {
        const { host, name } = sample.labels;
        if (!host || !name || !name.endsWith(".service") || name.startsWith("user@"))
            continue;
        result.push({
            id: resourceKey("service", host, name),
            host,
            name,
            kind: "service",
            state: resourceState(
                exporterAvailable(samples, host, "node") ? sample.value : null,
                "stopped"
            ),
        });
    }
    return result;
}

/**
 * Project SMART health without exposing serial numbers or unrelated device metadata.
 * @param samples - The validated monitoring inventory.
 * @returns Physical disk health, temperature and reported wear.
 */
export function buildDiskHealth(samples: MetricSamples): DiskHealthMetric[] {
    return (samples.smartctl_device_smart_status ?? []).flatMap((sample) => {
        const { host, device } = sample.labels;
        if (!host || !device) return [];
        const healthy = exporterAvailable(samples, host, "smartctl");
        return [
            {
                id: resourceKey(host, device),
                host,
                device,
                state: resourceState(healthy ? sample.value : null),
                temperature: healthy
                    ? measurement(samples, "smartctl_device_temperature", {
                          host,
                          device,
                      })
                    : null,
                wearPercent: healthy
                    ? measurement(samples, "smartctl_device_percentage_used", {
                          host,
                          device,
                      })
                    : null,
            },
        ];
    });
}
