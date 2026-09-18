import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";

import { inventoryQueries } from "./catalog";
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
import type { MetricSample } from "./samples";
import { queryMetrics, type MetricsConfiguration } from "./transport";

/**
 * Collect a bounded resource inventory using only the reviewed metric catalog.
 * @param configuration - The configured read-only monitoring endpoint.
 * @param signal - Worker deadline and ownership cancellation.
 * @param previous - Last successful inventory, used only to retain unavailable source identities.
 * @returns An atomic snapshot; a failed query never silently deletes an inventory section.
 */
export async function collectInventory(
    configuration: MetricsConfiguration,
    signal: AbortSignal,
    previous?: InfrastructureInventory | null
): Promise<InfrastructureInventory> {
    const samples: Record<string, MetricSample[]> = {};
    const entries = Object.entries(inventoryQueries);
    for (let offset = 0; offset < entries.length; offset += 4) {
        const results = await Promise.all(
            entries.slice(offset, offset + 4).map(async ([name, expression]) => ({
                name,
                result: await queryMetrics(configuration, expression, signal, true),
            }))
        );
        for (const { name, result } of results) {
            if (result.resultType !== "vector")
                throw new Error("Expected an inventory vector");
            for (const sample of result.result) {
                const key = [
                    "pve",
                    "node",
                    "applications",
                    "services",
                    "containers",
                    "native",
                ].includes(name)
                    ? (sample.metric.__name__ ?? name)
                    : name;
                const numeric = Number(sample.value[1]);
                (samples[key] ??= []).push({
                    labels: sample.metric,
                    value: Number.isFinite(numeric) ? numeric : null,
                });
            }
        }
    }
    const resources = buildResources(samples);
    return retainUnavailableInventory(
        {
            capturedAt: new Date().toISOString(),
            hosts: buildHosts(samples, previous?.hosts),
            ...resources,
            filesystems: [...resources.filesystems, ...homeAssistantFilesystems(samples)],
            storage: buildStorage(samples),
            applications: buildApplications(samples),
            services: buildServices(samples),
            diskHealth: buildDiskHealth(samples),
        },
        previous,
        samples
    );
}
