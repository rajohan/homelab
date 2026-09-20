import { PageHeader } from "@homelab/ui";

import { AlertsPanel } from "../features/alerts/AlertsPanel";
import { RulesPanel } from "../features/alerts/RulesPanel";

/**
 * Keep the alerts integration inside the common dashboard layout.
 * @returns The page heading and independent alerts view.
 */
export function Alerts() {
    return (
        <>
            <PageHeader
                title="Monitoring incidents"
                description="Current monitoring problems and recorded resolutions."
            />
            <div className="space-y-6">
                <AlertsPanel />
                <RulesPanel />
            </div>
        </>
    );
}
