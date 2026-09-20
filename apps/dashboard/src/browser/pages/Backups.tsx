import { PageHeader } from "@homelab/ui";

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
                title="Backups"
                description="Protection status across backup tasks and verification jobs."
            />
            <div className="space-y-6">
                <BackupsPanel />
                <SnapshotsPanel />
            </div>
        </>
    );
}
