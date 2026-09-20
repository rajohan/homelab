import type { BackupSnapshot } from "@homelab/contracts/backups";
import {
    DataTable,
    formatDateTime,
    formatMetric,
    type InfiniteScrollContinuation,
} from "@homelab/ui";

import { SnapshotStatus } from "./SnapshotStatus";

/**
 * Present read-only snapshot rows without treating retained mutable state as current.
 * @returns A virtualized metadata table whose health and protection share one availability boundary.
 */
export function SnapshotTable({
    snapshots,
    unavailable,
    continuation,
}: {
    readonly snapshots: readonly BackupSnapshot[];
    readonly unavailable: boolean;
    readonly continuation?: InfiniteScrollContinuation;
}) {
    return (
        <DataTable
            label="Backup snapshots"
            compact
            rows={snapshots}
            getKey={(row) => row.id}
            {...(continuation ? { continuation } : {})}
            columns={[
                {
                    id: "created",
                    label: "Created",
                    mobile: "title",
                    render: (row) => formatDateTime(row.createdAt),
                },
                {
                    id: "size",
                    label: "Logical size",
                    render: (row) => formatMetric(row.sizeBytes, "bytes"),
                },
                {
                    id: "verification",
                    label: "Verification",
                    render: (row) => (
                        <SnapshotStatus snapshot={row} stale={unavailable} />
                    ),
                },
                {
                    id: "protected",
                    label: "Protected",
                    render: (row) => {
                        if (unavailable) return "Unknown";
                        return row.protected ? "Yes" : "No";
                    },
                },
            ]}
        />
    );
}
