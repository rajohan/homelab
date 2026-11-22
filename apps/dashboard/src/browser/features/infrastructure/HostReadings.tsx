import type {
    FilesystemMetric,
    InfrastructureHost,
} from "@homelab/contracts/infrastructure";
import { formatMetric, ResourceReadings } from "@homelab/ui";

import { systemFilesystem } from "./systemFilesystem";

/** Use the same physical resource scales on the host shelf and inside its inspector.
 * @returns Three aligned readings for the selected host, including the root mount only.
 */
export function HostReadings({
    detailed = false,
    host,
    filesystems,
    stale,
}: {
    readonly detailed?: boolean;
    readonly host: InfrastructureHost;
    readonly filesystems: readonly FilesystemMetric[];
    readonly stale: boolean;
}) {
    const root = systemFilesystem(host.host, filesystems);
    const memory = stale ? null : host.memoryUsed;
    const disk = stale ? null : (root?.used ?? null);
    const cpu = stale ? null : host.cpuPercent;
    const loads = detailed
        ? [1, 5, 15].flatMap((minutes, index) => {
              const value = host.load[index];
              return typeof value === "number" && Number.isFinite(value)
                  ? [{ minutes, value: formatMetric(value) }]
                  : [];
          })
        : [];
    return (
        <ResourceReadings
            name={host.name}
            runtime={
                detailed
                    ? [{ label: "Uptime", value: formatMetric(host.uptime, "seconds") }]
                    : undefined
            }
            cpuNote={
                loads.length > 0 && (
                    <span
                        className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                        aria-label="Latest CPU load average"
                    >
                        <span>Load avg</span>
                        {loads.map(({ minutes, value }) => (
                            <span className="whitespace-nowrap" key={minutes}>
                                {minutes}m{" "}
                                <strong className="font-medium text-primary-200">
                                    {value}
                                </strong>
                            </span>
                        ))}
                    </span>
                )
            }
            cpu={cpu}
            cores={host.cores}
            memory={memory}
            capacity={stale ? null : host.memoryTotal}
            disk={{ used: disk, size: stale ? null : (root?.size ?? null) }}
        />
    );
}
