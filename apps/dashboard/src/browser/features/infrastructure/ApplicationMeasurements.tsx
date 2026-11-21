import type { ApplicationMetric } from "@homelab/contracts/infrastructure";
import { DetailSection, formatDateTime, formatMetric } from "@homelab/ui";
import { Gauge } from "lucide-react";

import { ApplicationHistory } from "./ApplicationHistory";
import { ApplicationReadings } from "./ApplicationReadings";

/** Present an application's measured runtime, effective capacity and sampled history.
 * @returns Resource sections within the shared application inspector.
 */
export function ApplicationMeasurements({
    application,
    capturedAt,
    cores,
    prefix,
    stale,
}: {
    readonly application: ApplicationMetric;
    readonly capturedAt: string;
    readonly cores: number | null;
    readonly prefix: string;
    readonly stale: boolean;
}) {
    const resources = application.resources;
    const start = application.startedAt;
    const hasStart = start !== null && Number.isFinite(start) && start > 0;
    const observed = Date.parse(capturedAt) / 1000;
    const confirmedRunning =
        application.state === "healthy" ||
        (application.state !== "stopped" && resources !== undefined);
    const uptime =
        hasStart && confirmedRunning && observed >= start ? observed - start : null;
    const runtime = [
        {
            label: "Uptime",
            value: formatMetric(uptime, "seconds"),
            detail: hasStart
                ? `Started ${formatDateTime(start * 1000)}`
                : "Start time not reported",
        },
        { label: "Restarts", value: formatMetric(application.restarts) },
        { label: "Processes / threads", value: formatMetric(resources?.pids) },
    ];
    return (
        <>
            {stale && (
                <p className="text-sm text-amber-300">
                    Last reported values · Current readings unavailable
                </p>
            )}
            <DetailSection icon={Gauge} title="Resource usage" anchor={prefix + "-usage"}>
                <ApplicationReadings
                    application={application}
                    stale={stale}
                    cores={cores}
                    runtime={runtime}
                />

                {!resources && (
                    <p className="text-sm text-primary-400">
                        No current application resource sample. Earlier history remains
                        available when collected.
                    </p>
                )}
            </DetailSection>
            <ApplicationHistory
                anchor={prefix + "-history"}
                id={application.id}
                name={application.name}
            />
        </>
    );
}
