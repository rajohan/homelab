import type { ApplicationMetric } from "@homelab/contracts/infrastructure";
import { Modal, formatDateTime, formatMetric } from "@homelab/ui";

import { ApplicationHistory } from "./ApplicationHistory";
import { MetricStat } from "./MetricStat";
import { ResourceStatus } from "./ResourceStatus";

/**
 * Describe application health, its own usage and the effective memory ceiling.
 * @returns A live detail dialog and scoped, read-only resource history.
 */
export function ApplicationDetails({
    application,
    onClose,
}: {
    readonly application: ApplicationMetric;
    readonly onClose: () => void;
}) {
    const resources = application.resources;
    return (
        <Modal
            title={application.name}
            titleAccessory={<ResourceStatus state={application.state} />}
            description={`${application.host} · ${application.project}`}
            onClose={onClose}
            size="wide"
        >
            <div className="space-y-5">
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <MetricStat
                        label="CPU"
                        value={formatMetric(resources?.cpuPercent ?? null, "percent")}
                    />
                    <MetricStat
                        label="Memory used"
                        value={formatMetric(resources?.memoryUsed ?? null, "bytes")}
                    />
                    <MetricStat
                        label="Memory capacity"
                        value={formatMetric(resources?.memoryCapacity ?? null, "bytes")}
                    />
                    <MetricStat
                        label="Processes / threads"
                        value={formatMetric(resources?.pids ?? null)}
                    />
                    <MetricStat
                        label="Restarts"
                        value={formatMetric(application.restarts)}
                    />
                    <MetricStat
                        label="Started"
                        value={
                            application.startedAt
                                ? formatDateTime(application.startedAt * 1000)
                                : "Not reported"
                        }
                    />
                </dl>
                {!resources && (
                    <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-3 text-sm text-primary-400">
                        No current application resource sample. Earlier history remains
                        available when collected.
                    </p>
                )}
                <ApplicationHistory id={application.id} name={application.name} />
            </div>
        </Modal>
    );
}
