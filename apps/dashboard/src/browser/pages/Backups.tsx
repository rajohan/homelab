import { PageHeader, PageSections } from "@homelab/ui";
import { Archive } from "lucide-react";

import { BackupsPanel } from "../features/backups/BackupsPanel";
import { SnapshotsPanel } from "../features/backups/SnapshotsPanel";

/**
 * Keep the backups integration inside the common dashboard layout.
 * @returns The page heading and independent backups view.
 */
export function Backups() {
    return (
        <>
            <PageHeader
                icon={Archive}
                title="Backups"
                description="Protection status across backup tasks and verification jobs."
            />
            <PageSections
                label="Backups sections"
                sections={[
                    {
                        id: "protection",
                        label: "Protection tasks",
                        content: <BackupsPanel />,
                    },
                    {
                        id: "snapshots",
                        label: "Backup snapshots",
                        content: <SnapshotsPanel />,
                    },
                ]}
            />
        </>
    );
}
