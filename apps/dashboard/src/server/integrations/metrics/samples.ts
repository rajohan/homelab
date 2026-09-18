import type { ResourceState } from "@homelab/contracts/infrastructure";

export interface MetricSample {
    readonly labels: Readonly<Record<string, string>>;
    readonly value: number | null;
}

/**
 * Interpret a binary health measurement without treating missing data as a failure or success.
 * @param value - A binary measurement, or null if collection was unavailable.
 * @param inactive - The semantic meaning of an explicit zero.
 * @returns A status suitable for a saved resource snapshot.
 */
export function resourceState(
    value: number | null,
    inactive: ResourceState = "unhealthy"
): ResourceState {
    if (value === 1) return "healthy";
    if (value === 0) return inactive;
    return "unknown";
}
export type MetricSamples = Readonly<Record<string, readonly MetricSample[]>>;

/**
 * Select exactly one matching series, treating duplicates and invalid values as unavailable.
 * @param samples - The fixed metric inventory.
 * @param name - Metric name or server-owned derived-query key.
 * @param labels - Labels required to identify this resource unambiguously.
 * @returns A finite nonnegative measurement, including a genuine zero, or null.
 */
export function measurement(
    samples: MetricSamples,
    name: string,
    labels: Readonly<Record<string, string>>
): number | null {
    const matches = (samples[name] ?? []).filter((sample) =>
        Object.entries(labels).every(([key, value]) => sample.labels[key] === value)
    );
    const value = matches.length === 1 ? matches[0]?.value : null;
    return value !== undefined && value !== null && Number.isFinite(value) && value >= 0
        ? value
        : null;
}

/**
 * Test exporter availability for a named host without treating missing scrape data as success.
 * @param samples - The fixed metric inventory.
 * @param host - The monitoring host label.
 * @param job - The expected scrape job.
 * @returns Whether exactly one matching exporter is currently reachable.
 */
export function exporterAvailable(
    samples: MetricSamples,
    host: string,
    job: string
): boolean {
    return measurement(samples, "up", { host, job }) === 1;
}

/**
 * Check whether a host's application inventory is authoritative for this collection.
 * @param samples - Current scrape and application collector measurements.
 * @param host - The monitored host whose application list is being read.
 * @param now - Collection time in seconds, injectable for freshness tests.
 * @returns Whether the reachable collector completed successfully within its freshness window.
 */
export function applicationInventoryAvailable(
    samples: MetricSamples,
    host: string,
    now = Date.now() / 1000
): boolean {
    const timestamp = measurement(samples, "homelab_app_last_run_timestamp_seconds", {
        host,
    });
    return (
        exporterAvailable(samples, host, "node") &&
        measurement(samples, "homelab_app_collector_success", { host }) === 1 &&
        timestamp !== null &&
        now - timestamp < 180 &&
        timestamp <= now + 60
    );
}

/**
 * Build a stable collision-safe key from source-owned identity parts.
 * @param parts - Source, host and resource identity components.
 * @returns An opaque key used only to select saved resources.
 */
export function resourceKey(...parts: string[]): string {
    return JSON.stringify(parts);
}
