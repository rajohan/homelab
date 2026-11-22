import { PageHeader, PageSections } from "@homelab/ui";
import { BellRing } from "lucide-react";

import { AlertsPanel } from "../features/alerts/AlertsPanel";
import { IncidentFromLocation } from "../features/alerts/IncidentFromLocation";
import { RulesPanel } from "../features/alerts/RulesPanel";

/**
 * Keep the alerts integration inside the common dashboard layout.
 * @returns The page heading and independent alerts view.
 */
export function Alerts() {
    return (
        <>
            <PageHeader
                icon={BellRing}
                title="Monitoring incidents"
                description="Current monitoring problems and recorded resolutions."
            />
            <PageSections
                label="Alerts sections"
                sections={[
                    {
                        id: "incidents",
                        label: "Current incidents",
                        content: <AlertsPanel state="current" />,
                    },
                    {
                        id: "resolved",
                        label: "Resolution history",
                        content: <AlertsPanel state="resolved" />,
                    },
                    { id: "rules", label: "Monitoring rules", content: <RulesPanel /> },
                ]}
            />
            <IncidentFromLocation />
        </>
    );
}
