import type { Incident } from "@homelab/contracts/alerts";
import { DetailFacts, DetailSection, formatDateTime, Modal } from "@homelab/ui";
import { BellRing, Radio } from "lucide-react";

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
            icon={Radio}
            description="Monitoring incident"
            onClose={onClose}
            titleAccessory={
                <IncidentStatus incident={incident} unavailable={unavailable} />
            }
        >
            <DetailSection icon={BellRing} title="Incident details">
                <DetailFacts
                    items={[
                        { label: "Host", value: incident.host ?? "Not reported" },
                        { label: "Service", value: incident.service ?? "Not reported" },
                        { label: "Started", value: formatDateTime(incident.startedAt) },
                        {
                            label: "Resolved",
                            value: incident.resolvedAt
                                ? formatDateTime(incident.resolvedAt)
                                : unresolved,
                        },
                    ]}
                />
            </DetailSection>
        </Modal>
    );
}
