import type { BackupInventory, BackupRecord } from "@homelab/contracts/backups";

import { measurement, exporterAvailable, type MetricSamples } from "../metrics/samples";
import { queryMetrics, type MetricsConfiguration } from "../metrics/transport";

function date(value: number | null): string | null {
    return value !== null && value > 0 && value < 8_640_000_000_000
        ? new Date(value * 1000).toISOString()
        : null;
}

/**
 * Interpret backup-specific health without substituting a recent scrape for a successful backup.
 * @param samples - Current metrics with exporter reachability.
 * @param previous - Prior identities retained only for unavailable exporters.
 * @param now - Current Unix time, injectable for deterministic boundary tests.
 * @returns Current backup statuses with missing measurements explicitly unknown.
 */
export function backupInventory(
    samples: MetricSamples,
    previous: BackupInventory | null,
    now = Date.now() / 1000
): BackupInventory {
    const identities = new Map<string, { host: string; task: string }>();
    for (const row of samples.homelab_backup_history_known ?? []) {
        const { host, task } = row.labels;
        if (host && task) identities.set(JSON.stringify([host, task]), { host, task });
    }
    for (const record of previous?.backups ?? []) {
        if (!exporterAvailable(samples, record.host, "node"))
            identities.set(record.id, record);
    }
    return {
        capturedAt: new Date(now * 1000).toISOString(),
        backups: [...identities]
            .map(([id, { host, task }]): BackupRecord => {
                const labels = { host, task };
                const available = exporterAvailable(samples, host, "node");
                const read = (name: string) =>
                    available
                        ? measurement(samples, `homelab_backup_${name}`, labels)
                        : null;
                const lastSuccess = read("last_success_timestamp_seconds");
                const maximumAgeSeconds = read("max_age_seconds");
                const historyKnown = read("history_known");
                let state: BackupRecord["state"] = "unknown";
                if (available && read("current_running") === 1) state = "running";
                else if (
                    available &&
                    (read("timer_enabled") === 0 || read("timer_active") === 0)
                )
                    state = "disabled";
                else if (
                    available &&
                    (read("current_failed") === 1 ||
                        (historyKnown === 1 && read("last_completed_success") === 0))
                )
                    state = "failed";
                else if (
                    historyKnown === 1 &&
                    lastSuccess !== null &&
                    lastSuccess > 0 &&
                    lastSuccess <= now + 60 &&
                    maximumAgeSeconds !== null &&
                    maximumAgeSeconds > 0 &&
                    read("last_completed_success") === 1
                )
                    state = now - lastSuccess > maximumAgeSeconds ? "overdue" : "healthy";
                return {
                    id,
                    host,
                    task,
                    state,
                    lastSuccessAt: date(lastSuccess),
                    lastFailureAt: date(read("last_failure_timestamp_seconds")),
                    maximumAgeSeconds,
                };
            })
            .toSorted(
                (left, right) =>
                    left.host.localeCompare(right.host) ||
                    left.task.localeCompare(right.task)
            ),
    };
}

/**
 * Collect only the existing backup-health metric family and node-exporter reachability.
 * @param configuration - Trusted read-only metrics API.
 * @param previous - Last persisted identities for outage handling.
 * @param signal - Job deadline and cancellation.
 * @returns An independently fresh backup inventory.
 */
export async function collectBackups(
    configuration: MetricsConfiguration,
    previous: BackupInventory | null,
    signal: AbortSignal
): Promise<BackupInventory> {
    const result = await queryMetrics(
        configuration,
        '{__name__=~"homelab_backup_.+|up",job="node"}',
        signal,
        true
    );
    if (result.resultType !== "vector")
        throw new Error("Backup metrics must be an instant vector");
    const samples: Record<
        string,
        { labels: Record<string, string>; value: number | null }[]
    > = {};
    for (const item of result.result) {
        const name = item.metric.__name__;
        if (!name) continue;
        const value = Number(item.value[1]);
        (samples[name] ??= []).push({
            labels: item.metric,
            value:
                Number.isFinite(value) && Date.now() / 1000 - item.value[0] < 180
                    ? value
                    : null,
        });
    }
    return backupInventory(samples, previous);
}
