import type { ManagedApplication } from "@homelab/contracts/applications";
import { Modal, Select } from "@homelab/ui";
import { useState } from "react";

import { ApplicationLogs } from "./ApplicationLogs";
import { ApplicationMetadata } from "./ApplicationMetadata";
import { ApplicationStatus } from "./ApplicationStatus";

/**
 * Inspect selected safe metadata and request logs only when their view is open.
 * @returns A bounded detail dialog preserving the live container identity.
 */
export function ApplicationInspector({
    application,
    logsAvailable,
    available,
    onClose,
}: {
    readonly application: ManagedApplication;
    readonly logsAvailable: boolean;
    readonly available: boolean;
    readonly onClose: () => void;
}) {
    const [view, setView] = useState<"details" | "logs">("details");
    return (
        <Modal
            title={application.name}
            titleAccessory={
                <ApplicationStatus
                    state={application.state}
                    health={application.health}
                    available={available}
                />
            }
            description={`${application.host} · ${application.project}`}
            onClose={onClose}
            size="wide"
        >
            <div className="space-y-4">
                <Select
                    label="View"
                    value={view}
                    onChange={setView}
                    options={[
                        { value: "details", label: "Details" },
                        ...(logsAvailable
                            ? [{ value: "logs" as const, label: "Logs" }]
                            : []),
                    ]}
                />
                {view === "details" ? (
                    <ApplicationMetadata application={application} />
                ) : (
                    <ApplicationLogs application={application} />
                )}
            </div>
        </Modal>
    );
}
