import { PageHeader, PageSections } from "@homelab/ui";
import { PackageCheck } from "lucide-react";

import { MaintenancePanel } from "../features/maintenance/MaintenancePanel";
import { BuildDependencies } from "../features/releases/BuildDependencies";
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
                icon={PackageCheck}
                title="Updates"
                description="Installed software, available versions and check coverage."
            />
            <PageSections
                deferBelowFold
                label="Updates sections"
                sections={[
                    { id: "software", label: "Software", content: <UpdatesPanel /> },
                    {
                        id: "maintenance",
                        label: "Maintenance",
                        content: <MaintenancePanel />,
                    },
                    { id: "releases", label: "Releases", content: <ReleasesPanel /> },
                    {
                        id: "dependencies",
                        label: "Build dependencies",
                        content: <BuildDependencies />,
                    },
                ]}
            />
        </>
    );
}
