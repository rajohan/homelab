import type { ApplicationMetric } from "@homelab/contracts/infrastructure";
import { GroupedDirectory } from "@homelab/ui";

import { resourceStateLabels } from "./resourceStateLabels";
import { ResourceStatus } from "./ResourceStatus";

/** Group monitored applications by project with the health from the current observation.
 * @returns A responsive service directory with direct access to the selected application.
 */
export function MonitoredApplicationDirectory({
    applications,
    stale,
    onSelect,
}: {
    readonly applications: readonly ApplicationMetric[];
    readonly stale: boolean;
    readonly onSelect: (item: ApplicationMetric) => void;
}) {
    const stateOf = (item: ApplicationMetric) => (stale ? "unknown" : item.state);
    return (
        <GroupedDirectory
            layout="index"
            items={applications}
            group={(item) => item.project || "No project reported"}
            getKey={(item) => item.id}
            name={(item) => item.name}
            detail={(item) => {
                const state = stateOf(item);
                return state === "healthy"
                    ? item.host
                    : [item.host, resourceStateLabels[state]].filter(Boolean).join(" · ");
            }}
            status={(item) => <ResourceStatus marker state={stateOf(item)} />}
            onSelect={onSelect}
        />
    );
}
