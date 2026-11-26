import { PageHeader, PageSections } from "@homelab/ui";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { PackageCheck } from "lucide-react";
import * as v from "valibot";

import { MaintenancePanel } from "../features/maintenance/MaintenancePanel";
import { RestartActivityDialog } from "../features/maintenance/RestartActivityDialog";
import { restartLocation } from "../features/maintenance/restartLocation";
import { BuildDependencies } from "../features/releases/BuildDependencies";
import { ReleasesPanel } from "../features/releases/ReleasesPanel";
import { UpdatesPanel } from "../features/updates/UpdatesPanel";

/**
 * Present software updates, confirmed maintenance and independently observed releases.
 * @returns The existing operations page with shared maintenance controls.
 */
export function Updates() {
    const { restartBatch } = v.parse(restartLocation, useSearch({ from: "/updates" }));
    const navigate = useNavigate({ from: "/updates" });
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
                        label: "Restarts",
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
            {restartBatch && (
                <RestartActivityDialog
                    kind="notification"
                    id={restartBatch}
                    title="Service restarts need attention"
                    onClose={() =>
                        void navigate({
                            search: {},
                            hash: true,
                            hashScrollIntoView: false,
                            resetScroll: false,
                            replace: true,
                        })
                    }
                />
            )}
        </>
    );
}
