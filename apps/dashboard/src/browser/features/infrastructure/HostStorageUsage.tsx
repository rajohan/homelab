import type { FilesystemMetric } from "@homelab/contracts/infrastructure";

import { ResourceUsage } from "./ResourceUsage";

/**
 * Show each host's system and data filesystem separately without adding shared capacity.
 * @returns Usage bars for measured filesystems, or an explicit missing-telemetry label.
 */
export function HostStorageUsage({
    host,
    filesystems,
    systemOnly = false,
}: {
    readonly host: string | null;
    readonly filesystems: readonly FilesystemMetric[];
    readonly systemOnly?: boolean;
}) {
    const volumes = filesystems
        .filter((row) => row.host === host && !/^\/boot(\/|$)/.test(row.mount))
        .toSorted((left, right) => left.mount.localeCompare(right.mount));
    const visible = systemOnly ? volumes.filter((row) => row.mount === "/") : volumes;
    if (volumes.length === 0)
        return <span className="text-primary-400">Not reported</span>;
    return (
        <div className="space-y-3">
            {visible.length === 0 && (
                <span className="text-primary-400">System filesystem not reported</span>
            )}
            {visible.map((volume) => (
                <ResourceUsage
                    key={volume.id}
                    used={volume.used}
                    total={volume.size}
                    description={volume.mount}
                />
            ))}
        </div>
    );
}
