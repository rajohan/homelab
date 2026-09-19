import type { BackupSnapshot } from "@homelab/contracts/backups";
import { Badge } from "@homelab/ui";

/**
 * Display the recorded snapshot verification result without implying a restore test passed.
 * @returns A verification badge with unknown status when collection is stale.
 */
export function SnapshotStatus({
    snapshot,
    stale,
}: {
    readonly snapshot: BackupSnapshot;
    readonly stale: boolean;
}) {
    if (stale) return <Badge tone="warning">Unknown</Badge>;
    if (snapshot.verification === "verified")
        return <Badge tone="positive">Verified</Badge>;
    if (snapshot.verification === "failed") return <Badge tone="danger">Failed</Badge>;
    return <Badge tone="warning">Not verified</Badge>;
}
