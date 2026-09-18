import { expect, test } from "bun:test";

import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";

import { homeAssistantFilesystems } from "./homeAssistant";
import { buildHosts } from "./hosts";
import {
    buildApplications,
    buildDiskHealth,
    buildResources,
    buildServices,
    buildStorage,
} from "./resources";
import { retainUnavailableInventory } from "./retention";
import type { MetricSample, MetricSamples } from "./samples";

const sample = (labels: Record<string, string>, value = 1): MetricSample => ({
    labels,
    value,
});
const pve = { host: "cluster", instance: 'cluster-"a', id: "qemu/100" };
const app = { host: "guest", project: "tools", service: "example" };
const storage = {
    ...pve,
    id: "storage/pve/pool",
    node: "pve",
    storage: "pool",
    plugintype: "zfspool",
};
const filesystem = { host: "guest", device: "sda", mountpoint: "/", fstype: "ext4" };
const device = { host: "guest", device: "eth0" };

function snapshot(
    samples: MetricSamples,
    previous?: InfrastructureInventory
): InfrastructureInventory {
    return {
        capturedAt: new Date().toISOString(),
        hosts: buildHosts(samples, previous?.hosts),
        ...buildResources(samples),
        storage: buildStorage(samples),
        applications: buildApplications(samples),
        services: buildServices(samples),
        diskHealth: buildDiskHealth(samples),
    };
}

function fixture(): MetricSamples {
    return {
        up: [
            sample({ host: "cluster", instance: pve.instance, job: "pve" }),
            sample({ host: "guest", job: "node" }),
            sample({ host: "guest", job: "smartctl" }),
            sample({ check: "https" }),
        ],
        pve_guest_info: [sample({ ...pve, name: "guest", node: "pve" })],
        pve_up: [sample(pve), sample(storage)],
        pve_memory_size_bytes: [sample(pve, 8192)],
        pve_memory_usage_bytes: [sample(pve, 2048)],
        pve_cpu_usage_ratio: [sample(pve, 0.25)],
        pve_storage_info: [sample(storage)],
        pve_disk_size_bytes: [sample(storage, 100)],
        pve_disk_usage_bytes: [sample(storage, 40)],
        homelab_app_expected: [sample(app)],
        homelab_app_collector_success: [sample({ host: "guest" })],
        homelab_app_last_run_timestamp_seconds: [
            sample({ host: "guest" }, Date.now() / 1000),
        ],
        homelab_app_present: [sample(app)],
        homelab_app_running: [sample(app)],
        homelab_app_ready: [sample(app)],
        homelab_native_app_info: [sample(app)],
        homelab_native_metrics_success: [sample(app)],
        homelab_native_last_sample_timestamp_seconds: [sample(app, Date.now() / 1000)],
        homelab_native_memory_working_set_bytes: [sample(app, 1024)],
        node_filesystem_size_bytes: [sample(filesystem, 100)],
        node_filesystem_free_bytes: [sample(filesystem, 40)],
        receive: [sample(device, 100)],
        read: [sample({ host: "guest", device: "sda" }, 200)],
        node_systemd_unit_state: [sample({ host: "guest", name: "example.service" })],
        probe_success: [sample({ check: "https" })],
        smartctl_device_smart_status: [sample({ host: "guest", device: "sda" })],
        smartctl_device_temperature: [sample({ host: "guest", device: "sda" }, 40)],
    };
}

test("failed exporters retain identities without old health, counters or resource measurements", () => {
    const previous = snapshot(fixture());
    expect(previous.applications[0]?.resources?.memoryUsed).toBe(1024);
    const failed = { up: fixture().up?.map((row) => ({ ...row, value: 0 })) ?? [] };
    const current = snapshot(failed, previous);
    expect(current.storage).toHaveLength(0);
    const result = retainUnavailableInventory(current, previous, failed);
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({
        id: previous.hosts[0]?.id,
        kind: "vm",
        state: "unknown",
        cpuPercent: null,
        memoryUsed: null,
        allocatedMemory: null,
    });
    expect(result.storage[0]).toMatchObject({
        id: previous.storage[0]?.id,
        state: "unknown",
        size: null,
        used: null,
    });
    expect(result.applications[0]).toMatchObject({
        id: previous.applications[0]?.id,
        state: "unknown",
        resourceSource: "native",
        restarts: null,
        startedAt: null,
    });
    expect(result.applications[0]?.resources).toBeUndefined();
    expect(result.filesystems[0]).toMatchObject({
        id: previous.filesystems[0]?.id,
        size: null,
        used: null,
        available: null,
    });
    expect(result.networks[0]).toMatchObject({ receive: null, speed: null });
    expect(result.disks[0]).toMatchObject({ read: null, write: null });
    expect(
        result.services
            .filter((row) => row.kind !== "exporter")
            .every((row) => row.state === "unknown")
    ).toBe(true);
    expect(result.diskHealth[0]).toMatchObject({ state: "unknown", temperature: null });
    expect(retainUnavailableInventory(current, result, failed)).toEqual(result);
    expect(previous.hosts[0]?.state).toBe("healthy");
    expect(previous.applications[0]?.resources?.memoryUsed).toBe(1024);
});

test("a failed PVE exporter does not duplicate a guest whose node exporter remains healthy", () => {
    const previous = snapshot(fixture());
    const failed = {
        up: [
            sample({ host: "cluster", instance: pve.instance, job: "pve" }, 0),
            sample({ host: "guest", job: "node" }),
        ],
    };
    expect(snapshot(failed).hosts[0]?.kind).toBe("host");
    const result = retainUnavailableInventory(
        snapshot(failed, previous),
        previous,
        failed
    );
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({ kind: "vm", state: "unknown" });
});

test.each([false, true])(
    "fresh guest telemetry survives PVE outages, including stale PVE series (metadata retained: %s)",
    (staleMetadata) => {
        const values = fixture();
        const previous = snapshot(values);
        const current: MetricSamples = {
            ...(staleMetadata ? values : {}),
            up: [
                sample({ host: "cluster", instance: pve.instance, job: "pve" }, 0),
                sample({ host: "guest", job: "node" }),
            ],
            cpu: [sample({ host: "guest" }, 12)],
            cores: [sample({ host: "guest" }, 4)],
            node_memory_MemTotal_bytes: [sample({ host: "guest" }, 4000)],
            node_memory_MemAvailable_bytes: [sample({ host: "guest" }, 1000)],
            node_memory_SwapTotal_bytes: [sample({ host: "guest" }, 500)],
            node_memory_SwapFree_bytes: [sample({ host: "guest" }, 400)],
            node_load1: [sample({ host: "guest" }, 1.5)],
            node_boot_time_seconds: [sample({ host: "guest" }, Date.now() / 1000 - 600)],
        };
        const result = retainUnavailableInventory(
            snapshot(current, previous),
            previous,
            current
        );
        expect(result.hosts).toHaveLength(1);
        expect(result.hosts[0]).toMatchObject({
            id: previous.hosts[0]?.id,
            kind: "vm",
            state: "unknown",
            cpuPercent: 12,
            cores: 4,
            memoryUsed: 3000,
            memoryTotal: 4000,
            memorySource: "guest",
            allocatedMemory: null,
            provisionedDisk: null,
            swapUsed: 100,
            swapTotal: 500,
            load: [1.5, null, null],
            guestMetricsAvailable: true,
        });
        expect(result.hosts[0]?.uptime).toBeGreaterThanOrEqual(599);
        const containers = snapshot({
            ...values,
            pve_guest_info: [sample({ ...pve, id: "lxc/100", name: "guest" })],
        });
        const container = buildHosts(
            { ...current, pve_guest_info: [] },
            containers.hosts
        )[0];
        expect(container).toMatchObject({
            kind: "container",
            cpuPercent: null,
            cores: null,
            memoryUsed: 3000,
            guestMetricsAvailable: true,
        });
    }
);

test("retained names participate in cross-cluster ambiguity checks before joining guest metrics", () => {
    const values = fixture();
    const previous = snapshot(values);
    const current: MetricSamples = {
        up: [
            sample({ host: "cluster", instance: pve.instance, job: "pve" }, 0),
            sample({ host: "other", instance: "cluster-b", job: "pve" }),
            sample({ host: "guest", job: "node" }),
        ],
        pve_guest_info: [
            sample({ ...pve, instance: "cluster-b", host: "other", name: "guest" }),
        ],
        cpu: [sample({ host: "guest" }, 90)],
    };
    const hosts = buildHosts(current, previous.hosts);
    expect(hosts).toHaveLength(3);
    const guests = hosts.filter((host) => host.kind === "vm");
    expect(guests).toHaveLength(2);
    expect(
        guests.every(
            (host) =>
                host.host === null &&
                host.cpuPercent === null &&
                !host.guestMetricsAvailable
        )
    ).toBe(true);
    expect(hosts.find((host) => host.kind === "host")?.cpuPercent).toBe(90);
});

test("a reachable PVE exporter still reports stopped guest allocations without stale runtime usage", () => {
    const values: MetricSamples = {
        ...fixture(),
        pve_up: [sample(pve, 0)],
        pve_cpu_usage_limit: [sample(pve, 2)],
        pve_disk_size_bytes: [sample(pve, 100)],
        cpu: [sample({ host: "guest" }, 90)],
    };
    expect(buildHosts(values)[0]).toMatchObject({
        state: "stopped",
        cores: 2,
        allocatedMemory: 8192,
        provisionedDisk: 100,
        cpuPercent: null,
        memoryUsed: null,
        guestMetricsAvailable: false,
    });
});

test("healthy sources remain authoritative for updates, real deletions and recovery", () => {
    const values = fixture();
    const previous = snapshot(values);
    const deleted = {
        ...values,
        pve_guest_info: [],
        pve_storage_info: [],
        homelab_app_expected: [],
        node_filesystem_size_bytes: [],
    };
    const current = snapshot(deleted);
    expect(retainUnavailableInventory(current, previous, deleted)).toEqual(current);
    const empty = snapshot({});
    expect(retainUnavailableInventory(empty, previous, {})).toEqual(empty);
    expect(retainUnavailableInventory(previous, null, values)).toBe(previous);
    const recovered = { ...values, pve_memory_usage_bytes: [sample(pve, 0)] };
    expect(
        retainUnavailableInventory(snapshot(recovered), previous, recovered).hosts[0]
            ?.memoryUsed
    ).toBe(0);
});

test("retention is scoped to the failed cluster even when storage and node names are identical", () => {
    const values = fixture();
    const previous = snapshot({
        ...values,
        pve_storage_info: [
            sample(storage),
            sample({ ...storage, instance: "cluster-b" }),
        ],
    });
    const failed = {
        up: [
            sample({ host: "cluster", job: "pve", instance: pve.instance }, 0),
            sample({ host: "other", job: "pve", instance: "cluster-b" }),
        ],
    };
    const result = retainUnavailableInventory(snapshot(failed), previous, failed);
    expect(result.storage).toHaveLength(1);
    expect(result.storage[0]?.id).toBe(previous.storage[0]?.id);
});

test("healthy ambiguous host joins are unchanged by retention", () => {
    const values = fixture();
    const ambiguous = {
        ...values,
        pve_guest_info: [
            sample({ ...pve, name: "guest" }),
            sample({ ...pve, instance: "cluster-b", name: "guest" }),
        ],
    };
    const current = snapshot(ambiguous);
    expect(current.hosts).toHaveLength(3);
    expect(retainUnavailableInventory(current, current, ambiguous).hosts).toEqual(
        current.hosts
    );
});

test("filesystem retention distinguishes native and Home Assistant sources on the same host", () => {
    const values = fixture();
    const reported = homeAssistantFilesystems({
        homeassistant_sensor_data_size_gib: [
            sample({ host: "guest", entity: "sensor.system_monitor_disk_use_config" }, 2),
        ],
    });
    const previous = {
        ...snapshot(values),
        filesystems: [...snapshot(values).filesystems, ...reported],
    };
    const failed = {
        ...values,
        up: [...(values.up ?? []), sample({ host: "guest", job: "homeassistant" }, 0)],
    };
    const result = retainUnavailableInventory(snapshot(failed), previous, failed);
    expect(result.filesystems).toHaveLength(2);
    expect(result.filesystems[0]?.used).toBe(60);
    expect(result.filesystems[1]?.used).toBeNull();
});

test.each([0, 1])(
    "missing app metadata is retained when the collector fails or is stale (success=%s)",
    (success) => {
        const values = fixture();
        const failed = {
            ...values,
            homelab_app_expected: [],
            homelab_app_collector_success: [sample({ host: "guest" }, success)],
            homelab_app_last_run_timestamp_seconds: [sample({ host: "guest" }, 1)],
        };
        const result = retainUnavailableInventory(
            snapshot(failed),
            snapshot(values),
            failed
        );
        expect(result.applications[0]).toMatchObject({
            state: "unknown",
            resourceSource: "native",
        });
        expect(result.applications[0]?.resources).toBeUndefined();
    }
);
