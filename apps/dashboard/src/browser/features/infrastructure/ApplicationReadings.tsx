import type { ApplicationMetric } from "@homelab/contracts/infrastructure";
import { ResourceReadings } from "@homelab/ui";
import type { ComponentProps } from "react";

/** Apply the container's per-core CPU scale and effective memory limit in both list and detail views.
 * @returns The resource measurements available for this observation.
 */
export function ApplicationReadings({
    application,
    cores,
    stale,
    runtime,
}: {
    readonly application: ApplicationMetric;
    readonly cores: number | null;
    readonly stale: boolean;
    readonly runtime?: ComponentProps<typeof ResourceReadings>["runtime"];
}) {
    const resources = application.resources;
    return (
        <ResourceReadings
            name={application.name}
            perCore
            cores={cores}
            runtime={runtime}
            cpu={stale ? null : (resources?.cpuPercent ?? null)}
            memory={stale ? null : (resources?.memoryUsed ?? null)}
            capacity={stale ? null : (resources?.memoryCapacity ?? null)}
        />
    );
}
