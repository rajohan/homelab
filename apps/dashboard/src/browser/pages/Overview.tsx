import { PageHeader } from "@homelab/ui";

import { AlertsPanel } from "../features/alerts/AlertsPanel";
import { BackupsPanel } from "../features/backups/BackupsPanel";
import { InfrastructureHealth } from "../features/overview/InfrastructureHealth";
import { QueueSummary } from "../features/overview/QueueSummary";
import { UpdatesPanel } from "../features/updates/UpdatesPanel";

/**
 * Compose operational domains with independent queries, loading and failure boundaries.
 * @returns A responsive health overview linked to each domain's canonical details.
 */
export function Overview() {
    return (
        <>
            <PageHeader
                title="Overview"
                description="System health, protection and work that needs attention."
            />
            <div className="space-y-5">
                <InfrastructureHealth />
                <div className="grid items-start gap-5 xl:grid-cols-2">
                    <AlertsPanel compact />
                    <BackupsPanel compact />
                    <UpdatesPanel compact />
                    <QueueSummary />
                </div>
            </div>
        </>
    );
}
