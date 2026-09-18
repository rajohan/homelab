import type { FilesystemMetric } from "@homelab/contracts/infrastructure";

import {
    exporterAvailable,
    measurement,
    resourceKey,
    type MetricSamples,
} from "./samples";

/**
 * Read System Monitor's paired used/free GiB sensors when no native filesystem exporter exists.
 * @param samples - Validated, bounded monitoring samples.
 * @returns Independently reported volumes; capacity is the sensor's used plus free space.
 */
export function homeAssistantFilesystems(samples: MetricSamples): FilesystemMetric[] {
    return (samples.homeassistant_sensor_data_size_gib ?? []).flatMap((sample) => {
        const { host, entity } = sample.labels;
        const suffix = entity?.match(/^sensor\.system_monitor_disk_use_(.+)$/)?.[1];
        if (
            !host ||
            !entity ||
            !suffix ||
            (samples.node_filesystem_size_bytes ?? []).some(
                (item) => item.labels.host === host
            )
        )
            return [];
        const freeEntity = `sensor.system_monitor_disk_free_${suffix}`;
        const value = (sensor: string) =>
            exporterAvailable(samples, host, "homeassistant") &&
            measurement(samples, "homeassistant_entity_available", {
                host,
                entity: sensor,
            }) === 1
                ? measurement(samples, "homeassistant_sensor_data_size_gib", {
                      host,
                      entity: sensor,
                  })
                : null;
        const used = value(entity);
        const free = value(freeEntity);
        return [
            {
                id: resourceKey(host, entity),
                host,
                mount: sample.labels.friendly_name?.match(/ (\/.*)$/)?.[1] ?? suffix,
                device: "Home Assistant System Monitor",
                type: "Reported capacity: used + free",
                size: used === null || free === null ? null : (used + free) * 1024 ** 3,
                used: used === null ? null : used * 1024 ** 3,
                available: free === null ? null : free * 1024 ** 3,
                readOnly: null,
            },
        ];
    });
}
