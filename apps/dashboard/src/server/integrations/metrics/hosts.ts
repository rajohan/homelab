import type {
    InfrastructureHost,
    ResourceState,
} from "@homelab/contracts/infrastructure";

import {
    exporterAvailable,
    measurement,
    resourceKey,
    resourceState,
    type MetricSamples,
} from "./samples";

function hostMeasurements(
    samples: MetricSamples,
    host: string | null,
    pve: Readonly<Record<string, string>> | null,
    active: boolean
) {
    const guest = host !== null && exporterAvailable(samples, host, "node") && active;
    const nodeValue = (name: string) =>
        guest && host ? measurement(samples, name, { host }) : null;
    const pveValue = (name: string) =>
        active && pve ? measurement(samples, name, pve) : null;
    const total = nodeValue("node_memory_MemTotal_bytes");
    const available = nodeValue("node_memory_MemAvailable_bytes");
    const swap = nodeValue("node_memory_SwapTotal_bytes");
    const swapFree = nodeValue("node_memory_SwapFree_bytes");
    const boot = nodeValue("node_boot_time_seconds");
    const cpu = pveValue("pve_cpu_usage_ratio");
    const container = pve?.id?.startsWith("lxc/") ?? false;
    let memorySource: InfrastructureHost["memorySource"] = "unavailable";
    if (active && pve && pveValue("pve_memory_usage_bytes") !== null)
        memorySource = "hypervisor";
    if (guest && total !== null && available !== null) memorySource = "guest";
    return {
        cpuPercent:
            (container ? null : nodeValue("cpu")) ?? (cpu === null ? null : cpu * 100),
        cores:
            (pve ? measurement(samples, "pve_cpu_usage_limit", pve) : null) ??
            nodeValue("cores"),
        memoryUsed:
            total !== null && available !== null
                ? Math.max(0, total - available)
                : pveValue("pve_memory_usage_bytes"),
        memoryTotal: total ?? pveValue("pve_memory_size_bytes"),
        allocatedMemory: pve ? measurement(samples, "pve_memory_size_bytes", pve) : total,
        memorySource,
        swapUsed:
            swap !== null && swapFree !== null ? Math.max(0, swap - swapFree) : null,
        swapTotal: swap,
        load: [
            nodeValue("node_load1"),
            nodeValue("node_load5"),
            nodeValue("node_load15"),
        ],
        uptime:
            boot === null
                ? pveValue("pve_uptime_seconds")
                : Math.max(0, Date.now() / 1000 - boot),
        provisionedDisk: pve ? measurement(samples, "pve_disk_size_bytes", pve) : null,
        guestMetricsAvailable: guest,
    };
}

/**
 * Join Proxmox inventory to guest metrics only when host names are unambiguous.
 * @param samples - Validated metric samples from this collection run.
 * @returns All PVE nodes and guests, plus monitored hosts outside PVE.
 */
export function buildHosts(samples: MetricSamples): InfrastructureHost[] {
    const inventory = [
        ...(samples.pve_node_info ?? []),
        ...(samples.pve_guest_info ?? []),
    ];
    const output: InfrastructureHost[] = [];
    const linked = new Set<string>();
    for (const sample of inventory) {
        const { id, instance, name, node, host: sourceHost } = sample.labels;
        if (!id || !instance || !name || sample.labels.template === "1") continue;
        const unique = inventory.filter((item) => item.labels.name === name).length === 1;
        const host = unique ? name : null;
        if (host) linked.add(host);
        const pve = { id, instance };
        const reachable = sourceHost
            ? exporterAvailable(samples, sourceHost, "pve")
            : false;
        const up = reachable ? measurement(samples, "pve_up", pve) : null;
        const state: ResourceState = resourceState(up, "stopped");
        let kind: InfrastructureHost["kind"] = "vm";
        if (id.startsWith("node/")) kind = "node";
        if (id.startsWith("lxc/")) kind = "container";
        output.push({
            id: resourceKey("pve", instance, id),
            name,
            kind,
            node: node ?? null,
            guestId: id,
            host,
            pveInstance: instance,
            state,
            ...hostMeasurements(samples, host, pve, state === "healthy"),
        });
    }
    for (const sample of samples.up ?? []) {
        const { host, job } = sample.labels;
        if (!host || job !== "node" || linked.has(host)) continue;
        linked.add(host);
        const active = exporterAvailable(samples, host, "node");
        output.push({
            id: resourceKey("node", host),
            name: host,
            kind: "host",
            node: null,
            guestId: null,
            host,
            pveInstance: null,
            state: active ? "healthy" : "unknown",
            ...hostMeasurements(samples, host, null, active),
        });
    }
    return output.toSorted((left, right) => left.name.localeCompare(right.name));
}
