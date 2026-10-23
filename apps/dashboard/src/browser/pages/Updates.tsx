import { PageHeader } from "@homelab/ui";

import { MaintenancePanel } from "../features/maintenance/MaintenancePanel";
import { ReleasesPanel } from "../features/releases/ReleasesPanel";
import { UpdatesPanel } from "../features/updates/UpdatesPanel";

/**
 * Present software updates, confirmed maintenance and independently observed releases.
 * @returns The existing operations page with shared maintenance controls.
 */
export function Updates() {
    return (
        <>
            <PageHeader
                title="Updates"
                description="Installed software, available versions and check coverage."
            />
            <UpdatesPanel />
            <MaintenancePanel />
            <ReleasesPanel />
        </>
    );
}
