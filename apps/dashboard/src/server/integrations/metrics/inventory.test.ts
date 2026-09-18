import { describe, expect, test } from "bun:test";

import { applicationHistoryExpressions } from "./applicationHistory";
import { inventoryQueries } from "./catalog";
import { containerCpuExpression } from "./containerCpu";
import { historyExpressions } from "./history";
import { homeAssistantFilesystems } from "./homeAssistant";
import { buildHosts } from "./hosts";
import { effectiveMemoryCapacity, memoryCapacityExpression } from "./memory";
import { nativeResourceExpressions } from "./nativeResources";
import {
    buildApplications,
    buildDiskHealth,
    buildResources,
    buildServices,
    buildStorage,
} from "./resources";
import {
    measurement,
    resourceKey,
    resourceState,
    type MetricSample,
    type MetricSamples,
} from "./samples";

function sample(value: number | null, labels: Record<string, string>): MetricSample {
    return { value, labels };
}
const pve = { host: "hypervisor", instance: "cluster-a", id: "qemu/100" };
const app = { host: "guest", project: "tools", service: "example" };

test("Home Assistant disk sensors retain byte units and never report unavailable values as zero", () => {
    const usedEntity = "sensor.system_monitor_disk_use_config";
    const freeEntity = "sensor.system_monitor_disk_free_config";
    const values = {
        up: [sample(1, { host: "ha", job: "homeassistant" })],
        homeassistant_entity_available: [
            sample(1, { host: "ha", entity: usedEntity }),
            sample(1, { host: "ha", entity: freeEntity }),
        ],
        homeassistant_sensor_data_size_gib: [
            sample(7, {
                host: "ha",
                entity: usedEntity,
                friendly_name: "System Monitor Disk use /config",
            }),
            sample(53, { host: "ha", entity: freeEntity }),
        ],
    };
    expect(homeAssistantFilesystems(values)[0]).toMatchObject({
        host: "ha",
        mount: "/config",
        used: 7 * 1024 ** 3,
        size: 60 * 1024 ** 3,
    });
    expect(homeAssistantFilesystems({ ...values, up: [] })[0]).toMatchObject({
        used: null,
        size: null,
    });
    expect(
        homeAssistantFilesystems({ ...values, homeassistant_entity_available: [] })[0]
            ?.used
    ).toBeNull();
    expect(
        homeAssistantFilesystems({
            ...values,
            node_filesystem_size_bytes: [sample(100, { host: "ha" })],
        })
    ).toEqual([]);
});

function fixture(): Record<string, MetricSample[]> {
    return {
        up: [
            sample(1, { host: "hypervisor", job: "pve" }),
            sample(1, { host: "guest", job: "node" }),
        ],
        pve_guest_info: [sample(1, { ...pve, name: "guest", node: "hypervisor" })],
        pve_up: [sample(1, pve)],
        pve_cpu_usage_ratio: [sample(0.25, pve)],
        pve_cpu_usage_limit: [sample(4, pve)],
        pve_memory_size_bytes: [sample(8192, pve)],
        pve_memory_usage_bytes: [sample(7000, pve)],
        node_memory_MemTotal_bytes: [sample(8000, { host: "guest" })],
        node_memory_MemAvailable_bytes: [sample(6000, { host: "guest" })],
        cpu: [sample(10, { host: "guest" })],
        cores: [sample(20, { host: "guest" })],
        homelab_app_expected: [sample(1, app)],
        homelab_app_present: [sample(1, app)],
        homelab_app_running: [sample(1, app)],
        homelab_app_ready: [sample(1, app)],
        homelab_app_collector_success: [sample(1, { host: "guest" })],
        homelab_app_last_run_timestamp_seconds: [sample(990, { host: "guest" })],
    };
}

describe("resource normalization", () => {
    test("joins the upstream PVE node name without inventing a node label or duplicate host", () => {
        const input = fixture();
        const node = { ...pve, id: "node/hypervisor" };
        // prometheus-pve-exporter v3.10.0 ClusterNodeCollector emits name, not node.
        input.pve_node_info = [
            sample(1, { ...node, name: "hypervisor", level: "", nodeid: "0" }),
        ];
        input.pve_up?.push(sample(1, node));
        input.up?.push(sample(1, { host: "hypervisor", job: "node" }));
        input.node_memory_MemTotal_bytes?.push(sample(16_000, { host: "hypervisor" }));
        input.node_memory_MemAvailable_bytes?.push(
            sample(12_000, { host: "hypervisor" })
        );
        const hosts = buildHosts(input);
        expect(hosts).toHaveLength(2);
        expect(hosts.find((host) => host.name === "hypervisor")).toMatchObject({
            kind: "node",
            host: "hypervisor",
            guestId: "node/hypervisor",
            node: null,
            state: "healthy",
            guestMetricsAvailable: true,
            memoryUsed: 4000,
            memoryTotal: 16_000,
        });
        expect(hosts.filter((host) => host.name === "hypervisor")).toHaveLength(1);
    });
    test.each(["vm", "container"] as const)(
        "agentless %s history uses upstream PVE counters rather than deprecated gauges",
        (kind) => {
            const input = fixture();
            input.up = input.up?.filter((row) => row.labels.job !== "node") ?? [];
            const host = buildHosts(input)[0];
            if (!host) throw new Error("Missing fixture host");
            expect(host.guestMetricsConfigured).toBe(false);
            const id = kind === "vm" ? "qemu/100" : "lxc/100";
            const selection = `instance="cluster-a",id="${id}"`;
            const history = historyExpressions(
                { ...host, kind, guestId: id, guestMetricsAvailable: false },
                null,
                null
            );
            expect(history).toMatchObject({
                receive: `rate(pve_network_receive_bytes_total{${selection}}[5m])`,
                transmit: `rate(pve_network_transmit_bytes_total{${selection}}[5m])`,
                read: `rate(pve_disk_read_bytes_total{${selection}}[5m])`,
                write: `rate(pve_disk_written_bytes_total{${selection}}[5m])`,
            });
        }
    );
    test("preserves zero and refuses ambiguous, missing, negative and nonfinite samples", () => {
        const values = {
            test: [
                sample(0, { host: "a" }),
                sample(1, { host: "b" }),
                sample(2, { host: "b" }),
                sample(-1, { host: "c" }),
                sample(Number.NaN, { host: "d" }),
            ],
        };
        expect(measurement(values, "test", { host: "a" })).toBe(0);
        for (const host of ["b", "c", "d", "e"])
            expect(measurement(values, "test", { host })).toBeNull();
        expect(measurement(values, "absent", {})).toBeNull();
        expect(resourceState(null)).toBe("unknown");
        expect(resourceState(4)).toBe("unknown");
        expect(resourceState(1)).toBe("healthy");
        expect(resourceState(0, "stopped")).toBe("stopped");
        expect(resourceKey("a:b", "c")).not.toBe(resourceKey("a", "b:c"));
    });
    test("distinguishes allocated, guest-visible and actually used memory", () => {
        const [host] = buildHosts(fixture());
        expect(host).toMatchObject({
            name: "guest",
            kind: "vm",
            memoryTotal: 8000,
            memoryUsed: 2000,
            allocatedMemory: 8192,
            memorySource: "guest",
            cpuPercent: 10,
            cores: 4,
        });
    });
    test("uses hypervisor fallback when the guest exporter is down", () => {
        const input = fixture();
        input.up = [
            sample(1, { host: "hypervisor", job: "pve" }),
            sample(0, { host: "guest", job: "node" }),
        ];
        expect(buildHosts(input)[0]).toMatchObject({
            memoryUsed: 7000,
            memoryTotal: 8192,
            memorySource: "hypervisor",
            cpuPercent: 25,
            guestMetricsAvailable: false,
            guestMetricsConfigured: true,
        });
    });
    test("does not report stale measurements for stopped guests or unreachable hypervisors", () => {
        const input = fixture();
        input.pve_up = [sample(0, pve)];
        expect(buildHosts(input)[0]).toMatchObject({
            state: "stopped",
            cpuPercent: null,
            memoryUsed: null,
        });
        input.up = [];
        expect(buildHosts(input)[0]).toMatchObject({
            state: "unknown",
            cpuPercent: null,
            memoryUsed: null,
        });
    });
    test.each(["vm", "container", "node", "host"] as const)(
        "%s history keeps its source and device selections while the exporter is down",
        (kind) => {
            const input = fixture();
            const healthy = buildHosts(input)[0];
            if (!healthy) throw new Error("Missing fixture host");
            input.up =
                input.up?.map((row) =>
                    row.labels.job === "node" ? { ...row, value: 0 } : row
                ) ?? [];
            const unavailable = buildHosts(input)[0];
            if (!unavailable) throw new Error("Missing unavailable host");
            expect(unavailable.guestMetricsAvailable).toBe(false);
            expect(unavailable.guestMetricsConfigured).toBe(true);
            const before = historyExpressions({ ...healthy, kind }, "eth0", "sda");
            const after = historyExpressions({ ...unavailable, kind }, "eth0", "sda");
            expect(after).toEqual(before);
            expect(after.memory).toContain("node_memory_MemAvailable_bytes");
            expect(after.receive).toContain('device="eth0"');
            expect(after.read).toContain('device="sda"');
            const other = historyExpressions({ ...unavailable, kind }, "eth1", "sdb");
            expect(other.receive).not.toBe(after.receive);
            expect(other.read).not.toBe(after.read);
            const ambiguous = historyExpressions(
                { ...unavailable, host: null },
                "eth0",
                "sda"
            );
            expect(ambiguous.receive).toContain("pve_network_receive_bytes_total");
            expect(ambiguous.memory).toContain("pve_memory_usage_bytes");
        }
    );
    test("stopped guests retain configured node history while legacy snapshots honor selected devices", () => {
        const input = fixture();
        input.pve_up = [sample(0, pve)];
        const host = buildHosts(input)[0];
        if (!host) throw new Error("Missing stopped host");
        expect(host.guestMetricsAvailable).toBe(false);
        expect(historyExpressions(host, null, null).memory).toContain("node_memory_");
        const { guestMetricsConfigured: _configured, ...legacy } = host;
        const history = historyExpressions(legacy, "eth0", "sda");
        expect(history.receive).toContain(
            'node_network_receive_bytes_total{host="guest",device="eth0"}'
        );
        expect(history.read).toContain(
            'node_disk_read_bytes_total{host="guest",device="sda"}'
        );
    });
    test("does not merge ambiguous guest names across clusters", () => {
        const input = fixture();
        input.pve_guest_info?.push(
            sample(1, { ...pve, instance: "cluster-b", name: "guest" })
        );
        const guests = buildHosts(input).filter((host) => host.kind === "vm");
        expect(guests).toHaveLength(2);
        expect(guests.map((host) => host.host)).toEqual([null, null]);
        expect(new Set(guests.map((host) => host.id)).size).toBe(2);
    });
    test("includes other physical hosts and omits templates", () => {
        const input = fixture();
        input.pve_guest_info?.push(
            sample(1, { ...pve, id: "qemu/999", name: "template", template: "1" })
        );
        input.up?.push(sample(1, { host: "remote", job: "node" }));
        expect(buildHosts(input).map((host) => host.name)).toEqual(["guest", "remote"]);
    });

    test("templates and unusable rows cannot make a valid guest name ambiguous", () => {
        const input = fixture();
        input.pve_guest_info?.push(
            sample(1, { ...pve, id: "qemu/999", name: "guest", template: "1" }),
            sample(1, { ...pve, id: "", name: "guest" }),
            sample(1, { ...pve, instance: "", name: "guest" }),
            sample(1, { ...pve, id: "qemu/998", name: "" })
        );
        const hosts = buildHosts(input);
        expect(hosts).toHaveLength(1);
        expect(hosts[0]).toMatchObject({
            kind: "vm",
            host: "guest",
            guestMetricsAvailable: true,
            memoryUsed: 2000,
            cpuPercent: 10,
        });
    });
    test("uses container allocation rather than host-wide CPU counters", () => {
        const input = fixture();
        for (const [key, rows] of Object.entries(input))
            if (key.startsWith("pve_"))
                input[key] = rows.map((row) => ({
                    ...row,
                    labels: { ...row.labels, id: "lxc/100" },
                }));
        const host = buildHosts(input)[0];
        expect(host).toMatchObject({ kind: "container", cpuPercent: 25, cores: 4 });
        if (!host) throw new Error("Missing fixture host");
        expect(historyExpressions(host, null, null).cpu).toContain("pve_cpu_usage_ratio");
    });
});

describe("resource tables", () => {
    test("memory capacity respects configured limits, host RAM and unknown measurements", () => {
        for (const [limit, total, expected] of [
            [0, 8000, 8000],
            [1024, 8000, 1024],
            [16_000, 8000, 8000],
            [1024, null, 1024],
            [1024, 0, 1024],
            [0, null, null],
            [0, 0, null],
            [null, 8000, null],
        ] as const) {
            expect(effectiveMemoryCapacity(limit, total)).toBe(expected);
        }
    });
    test("native apps use their own fresh measurements, never Docker or VM totals", () => {
        const values = {
            ...fixture(),
            homelab_native_app_info: [sample(1, app)],
            homelab_native_metrics_success: [sample(1, app)],
            homelab_native_last_sample_timestamp_seconds: [sample(990, app)],
            homelab_native_memory_working_set_bytes: [sample(512, app)],
            homelab_native_memory_limit_bytes: [sample(0, app)],
            homelab_native_pids: [sample(7, app)],
            nativeCpu: [sample(4, app)],
            nativeReceive: [sample(0, app)],
            nativeRead: [sample(128, app)],
            containerCpu: [sample(88, app)],
            homelab_container_memory_working_set_bytes: [sample(9000, app)],
        };
        expect(buildApplications(values, 1000)[0]).toMatchObject({
            resourceSource: "native",
            resources: {
                cpuPercent: 4,
                memoryUsed: 512,
                memoryLimit: 0,
                memoryCapacity: 8000,
                pids: 7,
                receive: 0,
                transmit: null,
                read: 128,
            },
        });
        for (const override of [
            { homelab_native_metrics_success: [sample(0, app)] },
            { homelab_native_last_sample_timestamp_seconds: [sample(800, app)] },
            { homelab_native_last_sample_timestamp_seconds: [sample(1100, app)] },
            { homelab_app_running: [sample(0, app)] },
            { up: [] },
        ]) {
            const application = buildApplications({ ...values, ...override }, 1000)[0];
            expect(application?.resourceSource).toBe("native");
            expect(application?.resources).toBeUndefined();
        }
    });
    test("native current and historical queries handle each unit reset before aggregation", () => {
        const application = buildApplications(fixture(), 1000)[0];
        if (!application) throw new Error("Missing fixture application");
        const selector = 'host="guest",project="tools",service="example"';
        const history = applicationHistoryExpressions({
            ...application,
            resourceSource: "native",
        });
        const native = nativeResourceExpressions(selector, true);
        expect(history.cpu).toContain(native.cpu);
        expect(history.cpu).toContain("sum by(host,project,service) (rate(");
        expect(history.cpu).toContain("homelab_native_unit_running");
        expect(history.cpu).not.toContain("homelab_native_cpu_capacity_cores");
        expect(history.cpu).toStartWith("100 * sum by(host,project,service)");
        expect(history.cpu).not.toContain("homelab_container_");
        expect(history.memory).toContain("homelab_native_memory_working_set_bytes");
        expect(history.memoryCapacity).toContain("homelab_native_memory_limit_bytes");
        expect(history.memoryCapacity).toContain(
            'node_memory_MemTotal_bytes{host="guest"}'
        );
        expect(history.memory).toContain("< 180");
        expect(history.memory).toContain(">= -60");
        expect(history.receive).toContain("homelab_native_network_available");
        expect(history.read).toContain("homelab_native_block_available");
        expect(inventoryQueries.nativeCpu).toBe(nativeResourceExpressions().cpu);
        expect(inventoryQueries.nativeReceive).toContain("irate(");
        const escaped = applicationHistoryExpressions({
            ...application,
            resourceSource: "native",
            project: 'a"b',
        });
        expect(escaped.cpu).toContain(String.raw`project="a\"b"`);
    });
    test("container resources retain unlimited limits and reject stale, failed or stopped samples", () => {
        const values = {
            ...fixture(),
            homelab_container_metrics_success: [sample(1, app)],
            homelab_container_last_sample_timestamp_seconds: [sample(990, app)],
            homelab_container_memory_working_set_bytes: [sample(1024, app)],
            homelab_container_memory_limit_bytes: [sample(0, app)],
            homelab_container_network_shared: [sample(1, app)],
            containerCpu: [sample(11.25, app)],
            containerReceive: [sample(0, app)],
        };
        expect(buildApplications(values, 1000)[0]?.resources).toMatchObject({
            cpuPercent: 11.25,
            memoryUsed: 1024,
            memoryLimit: 0,
            memoryCapacity: 8000,
            receive: 0,
            transmit: null,
            networkShared: true,
        });
        for (const override of [
            { homelab_container_metrics_success: [sample(0, app)] },
            { homelab_container_last_sample_timestamp_seconds: [sample(800, app)] },
            { homelab_container_last_sample_timestamp_seconds: [sample(1100, app)] },
            { homelab_app_running: [sample(0, app)] },
            { up: [] },
        ])
            expect(
                buildApplications({ ...values, ...override }, 1000)[0]?.resources
            ).toBeUndefined();
        expect(buildApplications(fixture(), 1000)[0]?.resources).toBeUndefined();
    });
    test("container history escapes all identity labels and bounds freshness", () => {
        const application = buildApplications(fixture(), 1000)[0];
        if (!application) throw new Error("Missing fixture application");
        const result = applicationHistoryExpressions({ ...application, project: 'a"b' });
        expect(result.cpu).toContain(String.raw`project="a\"b"`);
        expect(result.cpu).toContain("100 * rate(");
        expect(result.cpu).toContain(
            containerCpuExpression(
                'host="guest",project="a\\\"b",service="example"',
                true
            )
        );
        expect(result.memory).toContain("< 180");
        expect(result.memory).toContain(">= -60");
        expect(result.memoryCapacity).toContain(
            memoryCapacityExpression(
                String.raw`homelab_container_memory_limit_bytes{host="guest",project="a\"b",service="example"}`,
                'node_memory_MemTotal_bytes{host="guest"}'
            )
        );
        expect(result.memoryCapacity).toContain("< 180");
        expect(result.memoryCapacity).not.toContain("MemAvailable");
    });
    test("current and historical application CPU follow Docker's one-core percentage convention", () => {
        const selector = 'host="guest",project="tools",service="example"';
        expect(inventoryQueries.containerCpu).toBe(containerCpuExpression());
        for (const historical of [false, true]) {
            const expression = containerCpuExpression(selector, historical);
            expect(expression).toBe(
                `100 * ${historical ? "rate" : "irate"}(homelab_container_cpu_usage_seconds_total{${selector}}[${historical ? "5m" : "1m"}])`
            );
            expect(expression).not.toContain("cpu_capacity_cores");
            const native = nativeResourceExpressions(selector, historical).cpu;
            expect(native).toStartWith("100 * sum by(host,project,service)");
            expect(native).not.toContain("cpu_capacity_cores");
            expect(expression).not.toContain("or vector(0)");
        }
    });
    test("keeps filesystems independent, excludes pseudo mounts, and preserves readonly state", () => {
        const labels = {
            host: "guest",
            device: "disk",
            mountpoint: "/data",
            fstype: "ext4",
        };
        const input: MetricSamples = {
            ...fixture(),
            node_filesystem_size_bytes: [
                sample(100, labels),
                sample(100, { ...labels, mountpoint: "/run/alias" }),
                sample(100, { ...labels, fstype: "tmpfs" }),
            ],
            node_filesystem_free_bytes: [sample(30, labels)],
            node_filesystem_avail_bytes: [sample(20, labels)],
            node_filesystem_readonly: [sample(1, labels)],
        };
        expect(buildResources(input).filesystems).toHaveLength(1);
        expect(buildResources(input).filesystems[0]).toMatchObject({
            size: 100,
            used: 70,
            available: 20,
            readOnly: true,
        });
        expect(
            buildResources({
                ...input,
                node_filesystem_device_error: [sample(1, labels)],
            }).filesystems[0]?.size
        ).toBeNull();
    });
    test("separates virtual interfaces, unknown speed, real zero traffic and logical disks", () => {
        const device = { host: "guest", device: "eth0" };
        const input = {
            ...fixture(),
            receive: [
                sample(0, device),
                sample(4, { ...device, device: "vmbr0" }),
                sample(9, { ...device, device: "lo" }),
            ],
            transmit: [sample(3, device)],
            node_network_up: [sample(1, device)],
            node_network_speed_bytes: [sample(1e18, device)],
            read: [
                sample(10, { host: "guest", device: "sda" }),
                sample(20, { host: "guest", device: "loop0" }),
            ],
        };
        const result = buildResources(input);
        expect(result.networks).toHaveLength(2);
        expect(result.networks[0]).toMatchObject({
            receive: 0,
            transmit: 3,
            speed: null,
            virtual: false,
        });
        expect(result.networks[1]?.virtual).toBe(true);
        expect(result.disks).toHaveLength(1);
        expect(buildResources({ ...input, up: [] }).networks[0]?.receive).toBeNull();
    });

    test("single-scrape device identities remain selectable before rates exist", () => {
        const node = { host: "guest", device: "eth0" };
        const input: MetricSamples = {
            ...fixture(),
            node_network_up: [
                sample(1, node),
                sample(0, { ...node, device: "eth1" }),
                sample(1, { ...node, device: "lo" }),
            ],
            node_network_speed_bytes: [
                sample(125_000_000, node),
                sample(100, { ...node, device: "speed-only" }),
            ],
            node_network_receive_bytes_total: [
                sample(2000, node),
                sample(0, { ...node, device: "counter-only" }),
                sample(10, { device: "missing-host" }),
            ],
            node_disk_read_bytes_total: [
                sample(2000, { host: "guest", device: "sda" }),
                sample(0, { host: "guest", device: "loop0" }),
            ],
        };
        const first = buildResources(input);
        expect(first.networks).toHaveLength(4);
        expect(first.networks[0]).toMatchObject({
            host: "guest",
            device: "eth0",
            up: true,
            speed: 125_000_000,
            receive: null,
            transmit: null,
        });
        expect(first.networks[1]).toMatchObject({
            device: "eth1",
            up: false,
            receive: null,
        });
        expect(first.networks.every((network) => network.receive === null)).toBe(true);
        expect(first.disks).toHaveLength(1);
        expect(first.disks[0]).toMatchObject({ device: "sda", read: null, write: null });
        const next = buildResources({
            ...input,
            receive: [sample(0, node)],
            read: [sample(25, { host: "guest", device: "sda" })],
        });
        expect(next.networks.map((network) => network.id)).toEqual(
            first.networks.map((network) => network.id)
        );
        expect(next.networks[0]?.receive).toBe(0);
        expect(next.disks[0]).toMatchObject({ id: first.disks[0]?.id, read: 25 });
        expect(inventoryQueries.node).toContain("node_network_receive_bytes_total");
        expect(inventoryQueries.node).toContain("node_disk_read_bytes_total");
    });
    test.each(["dir", "zfspool", "nfs", "pbs"])(
        "reports upstream %s pool type and capacity without aggregating aliases",
        (backend) => {
            const labels = { ...pve, id: "storage/node/pool" };
            const rows = buildStorage({
                ...fixture(),
                pve_storage_info: [
                    sample(1, {
                        ...labels,
                        node: "node",
                        storage: "pool",
                        plugintype: backend,
                    }),
                ],
                pve_up: [sample(1, labels)],
                pve_disk_size_bytes: [sample(500, labels)],
                pve_disk_usage_bytes: [sample(100, labels)],
            });
            expect(rows[0]).toMatchObject({
                name: "pool",
                type: backend,
                size: 500,
                used: 100,
                state: "healthy",
            });
        }
    );
    test("unknown and failed applications are not reported as healthy", () => {
        expect(buildApplications(fixture(), 1000)[0]?.state).toBe("healthy");
        expect(buildApplications(fixture(), 1300)[0]?.state).toBe("unknown");
        expect(
            buildApplications({ ...fixture(), homelab_app_ready: [] }, 1000)[0]?.state
        ).toBe("unknown");
        expect(
            buildApplications(
                { ...fixture(), homelab_app_present: [sample(0, app)] },
                1000
            )[0]?.state
        ).toBe("unhealthy");
        expect(
            buildApplications(
                {
                    ...fixture(),
                    homelab_app_collector_success: [sample(0, { host: "guest" })],
                },
                1000
            )[0]?.state
        ).toBe("unknown");
    });
    test("separates scrape health from blackbox health and strips private instance URLs", () => {
        const rows = buildServices({
            up: [
                sample(1, {
                    check: "https",
                    instance: "https://secret.test/private?token=never-return",
                }),
            ],
            probe_success: [sample(0, { check: "https" })],
        });
        expect(rows[0]).toMatchObject({ kind: "probe", state: "unhealthy" });
        expect(JSON.stringify(rows)).not.toContain("secret.test");
        expect(
            buildServices({ probe_success: [sample(1, { check: "https" })] })[0]?.state
        ).toBe("unknown");
    });
    test("reports SMART state only while its exporter is reachable", () => {
        const input = {
            up: [sample(1, { host: "node", job: "smartctl" })],
            smartctl_device_smart_status: [sample(1, { host: "node", device: "disk" })],
            smartctl_device_temperature: [sample(31, { host: "node", device: "disk" })],
        };
        expect(buildDiskHealth(input)[0]).toMatchObject({
            state: "healthy",
            temperature: 31,
        });
        expect(buildDiskHealth({ ...input, up: [] })[0]?.state).toBe("unknown");
    });
    test("escapes monitored resource labels before building historical expressions", () => {
        const host = buildHosts(fixture())[0];
        if (!host) throw new Error("Missing fixture host");
        const result = historyExpressions(
            { ...host, host: 'guest"},secret="x' },
            'eth"0',
            "disk"
        );
        expect(result.receive).toContain('host="guest\\\"},secret=\\\"x"');
        expect(result.receive).toContain('device="eth\\\"0"');
        expect(result.memoryCapacity).toBe(
            'node_memory_MemTotal_bytes{host="guest\\\"},secret=\\\"x"}'
        );
        expect(
            historyExpressions(
                { ...host, guestMetricsAvailable: false, guestMetricsConfigured: false },
                null,
                null
            ).memoryCapacity
        ).toBe('pve_memory_size_bytes{instance="cluster-a",id="qemu/100"}');
        expect(
            historyExpressions(
                { ...host, guestMetricsAvailable: false, guestMetricsConfigured: false },
                null,
                null
            ).read
        ).toContain("pve_disk_read_bytes_total");
    });
});
