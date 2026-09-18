import type {
    HistoryRange,
    InfrastructureHistory,
    InfrastructureHost,
    MetricSeries,
} from "@homelab/contracts/infrastructure";

import { queryMetrics, type MetricsConfiguration } from "./transport";

const ranges: Readonly<Record<HistoryRange, { duration: string; step: number }>> = {
    "1h": { duration: "1h", step: 15 },
    "6h": { duration: "6h", step: 60 },
    "24h": { duration: "24h", step: 300 },
    "7d": { duration: "7d", step: 1800 },
};

/**
 * Build expressions only from resource identities previously saved by the worker.
 * @param host - A saved inventory host, never arbitrary browser labels.
 * @param network - An inventory-validated interface or null.
 * @param disk - An inventory-validated block device or null.
 * @returns Fixed, scalar time-series expressions; null groups are unsupported.
 */
export function historyExpressions(
    host: InfrastructureHost,
    network: string | null,
    disk: string | null
) {
    const label = JSON.stringify;
    const selector = `host=${label(host.host)}`;
    const pve = `instance=${label(host.pveInstance)},id=${label(host.guestId)}`;
    const node = host.guestMetricsAvailable && host.host !== null;
    const hasPve = host.pveInstance !== null && host.guestId !== null;
    const virtualMachine = hasPve && host.kind !== "node";
    const fallback = {
        cpu: hasPve ? `100 * pve_cpu_usage_ratio{${pve}}` : null,
        memory: hasPve ? `pve_memory_usage_bytes{${pve}}` : null,
        memoryCapacity: hasPve ? `pve_memory_size_bytes{${pve}}` : null,
        receive: virtualMachine
            ? `rate(pve_network_receive_bytes_total{${pve}}[5m])`
            : null,
        transmit: virtualMachine
            ? `rate(pve_network_transmit_bytes_total{${pve}}[5m])`
            : null,
        read: virtualMachine ? `rate(pve_disk_read_bytes_total{${pve}}[5m])` : null,
        write: virtualMachine ? `rate(pve_disk_written_bytes_total{${pve}}[5m])` : null,
    };
    if (!node) return fallback;
    return {
        cpu:
            host.kind === "container"
                ? fallback.cpu
                : `100 * (1 - avg(rate(node_cpu_seconds_total{${selector},mode="idle"}[5m])))`,
        memory: `node_memory_MemTotal_bytes{${selector}} - node_memory_MemAvailable_bytes{${selector}}`,
        memoryCapacity: `node_memory_MemTotal_bytes{${selector}}`,
        receive: network
            ? `rate(node_network_receive_bytes_total{${selector},device=${label(network)}}[5m])`
            : fallback.receive,
        transmit: network
            ? `rate(node_network_transmit_bytes_total{${selector},device=${label(network)}}[5m])`
            : fallback.transmit,
        read: disk
            ? `rate(node_disk_read_bytes_total{${selector},device=${label(disk)}}[5m])`
            : fallback.read,
        write: disk
            ? `rate(node_disk_written_bytes_total{${selector},device=${label(disk)}}[5m])`
            : fallback.write,
    };
}

/**
 * Query bounded historical series from monitoring rather than duplicating its time-series database.
 * @param configuration - Trusted monitoring endpoint and read credential.
 * @param resource - Saved host and validated optional device selections.
 * @param range - One of the bounded public time windows.
 * @param signal - HTTP request cancellation combined with a fixed deadline.
 * @returns Named series with explicit gaps, not interpolated or fabricated zeroes.
 */
export async function collectHistory(
    configuration: MetricsConfiguration,
    resource: { host: InfrastructureHost; network: string | null; disk: string | null },
    range: HistoryRange,
    signal: AbortSignal
): Promise<InfrastructureHistory> {
    const expressions = historyExpressions(
        resource.host,
        resource.network,
        resource.disk
    );
    const labels: Readonly<Record<string, string>> = {
        cpu: "CPU",
        memory:
            resource.host.memorySource === "guest" ? "Used memory" : "Hypervisor memory",
        memoryCapacity: "Capacity",
        receive: "Received",
        transmit: "Sent",
        read: "Read",
        write: "Written",
    };
    return collectMetricHistory(configuration, expressions, range, signal, labels);
}

/**
 * Read shared, bounded chart groups for server-constructed host or application expressions.
 * @param configuration - Trusted monitoring endpoint.
 * @param expressions - Fixed expressions constructed from saved inventory identities.
 * @param range - Bounded historical window.
 * @param signal - Caller cancellation and deadline.
 * @param labels - Presentation labels selected by the resource integration.
 * @returns CPU, memory, network and block-I/O series with explicit gaps.
 */
export async function collectMetricHistory(
    configuration: MetricsConfiguration,
    expressions: Readonly<Record<string, string | null>>,
    range: HistoryRange,
    signal: AbortSignal,
    labels: Readonly<Record<string, string>> = {}
): Promise<InfrastructureHistory> {
    const { duration, step } = ranges[range];
    const series: Record<string, MetricSeries> = {};
    // Subqueries use the existing read-only instant-query route, not a second proxy API.
    await Promise.all(
        Object.entries(expressions).map(async ([key, expression]) => {
            if (!expression) return;
            const result = await queryMetrics(
                configuration,
                `(${expression})[${duration}:${step}s]`,
                signal
            );
            if (result.resultType !== "matrix" || result.result.length > 1)
                throw new Error("Historical resource is ambiguous");
            const values = result.result[0]?.values ?? [];
            const points: { time: number; value: number | null }[] = [];
            let previous: number | undefined;
            for (const [timestamp, value] of values) {
                if (previous !== undefined && timestamp - previous > step * 1.5)
                    points.push({ time: (previous + step) * 1000, value: null });
                const numeric = Number(value);
                points.push({
                    time: timestamp * 1000,
                    value: Number.isFinite(numeric) && numeric >= 0 ? numeric : null,
                });
                previous = timestamp;
            }
            series[key] = { key, label: labels[key] ?? key, points };
        })
    );
    const group = (...keys: string[]) =>
        keys.flatMap((key) => (series[key] ? [series[key]] : []));
    return {
        capturedAt: new Date().toISOString(),
        cpu: group("cpu"),
        memory: group("memory", "memoryCapacity"),
        network: group("receive", "transmit"),
        disk: group("read", "write"),
    };
}
