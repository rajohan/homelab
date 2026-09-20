import type { Incident } from "@homelab/contracts/alerts";
import { Modal, formatDateTime } from "@homelab/ui";

import { IncidentStatus } from "./IncidentStatus";

/**
 * Display monitoring-owned incident state without controls that could silence or resolve it.
 * @returns Read-only timing and affected-resource information.
 */
export function IncidentDetails({
    incident,
    unavailable,
    onClose,
}: {
    readonly incident: Incident;
    readonly unavailable: boolean;
    readonly onClose: () => void;
}) {
    const unresolved = unavailable ? "Unknown" : "Not resolved";
    return (
        <Modal
            title={incident.name}
            description="Monitoring status and affected resources."
            onClose={onClose}
            titleAccessory={
                <IncidentStatus incident={incident} unavailable={unavailable} />
            }
        >
            <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                    <dt className="text-primary-400">Host</dt>
                    <dd className="mt-1 wrap-anywhere">
                        {incident.host ?? "Not reported"}
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400">Service</dt>
                    <dd className="mt-1 wrap-anywhere">
                        {incident.service ?? "Not reported"}
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400">Started</dt>
                    <dd className="mt-1">{formatDateTime(incident.startedAt)}</dd>
                </div>
                <div>
                    <dt className="text-primary-400">Resolved</dt>
                    <dd className="mt-1">
                        {incident.resolvedAt
                            ? formatDateTime(incident.resolvedAt)
                            : unresolved}
                    </dd>
                </div>
            </dl>
        </Modal>
    );
}
