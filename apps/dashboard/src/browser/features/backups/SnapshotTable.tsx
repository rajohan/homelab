import type { BackupSnapshot } from "@homelab/contracts/backups";
import type { TableSort } from "@homelab/contracts/tableSort";
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
    sort,
    onSortChange,
}: {
    readonly snapshots: readonly BackupSnapshot[];
    readonly unavailable: boolean;
    readonly continuation?: InfiniteScrollContinuation;
    readonly sort?: TableSort | null;
    readonly onSortChange?: (sort: TableSort | null) => void;
}) {
    return (
        <DataTable
            label="Backup snapshots"
            compact
            rows={snapshots}
            {...(sort === undefined ? {} : { sort })}
            {...(onSortChange ? { onSortChange } : {})}
            getKey={(row) => row.id}
            {...(continuation ? { continuation } : {})}
            columns={[
                {
                    id: "created",
                    sortValue: (row) => row.createdAt,
                    label: "Created",
                    mobile: "title",
                    render: (row) => formatDateTime(row.createdAt),
                },
                {
                    id: "size",
                    sortValue: (row) => row.sizeBytes,
                    label: "Logical size",
                    render: (row) => formatMetric(row.sizeBytes, "bytes"),
                },
                {
                    id: "verification",
                    sortValue: (row) => (unavailable ? null : row.verification),
                    label: "Verification",
                    render: (row) => (
                        <SnapshotStatus snapshot={row} stale={unavailable} />
                    ),
                },
                {
                    id: "protected",
                    sortValue: (row) => (unavailable ? null : row.protected),
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
