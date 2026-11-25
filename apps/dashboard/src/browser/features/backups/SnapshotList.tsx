import type { BackupSnapshot } from "@homelab/contracts/backups";
import type { TableSort } from "@homelab/contracts/tableSort";
import {
    DetailEntry,
    DetailFacts,
    formatDateTime,
    formatMetric,
    type InfiniteScrollContinuation,
    SortControl,
    VirtualList,
} from "@homelab/ui";

import { SnapshotStatus } from "./SnapshotStatus";

/**
 * Present read-only snapshot rows without treating retained mutable state as current.
 * @returns A virtualized metadata list whose health and protection share one availability boundary.
 */
export function SnapshotList({
    snapshots,
    total,
    unavailable,
    continuation,
    sort,
    onSortChange,
}: {
    readonly total: number;
    readonly snapshots: readonly BackupSnapshot[];
    readonly unavailable: boolean;
    readonly continuation?: InfiniteScrollContinuation;
    readonly sort: TableSort | null;
    readonly onSortChange: (sort: TableSort | null) => void;
}) {
    const protection = (value: boolean) => {
        if (unavailable) return "Unknown";
        return value ? "Yes" : "No";
    };
    return (
        <div className="grid min-w-0 gap-3">
            {total > 12 && (
                <SortControl
                    label="snapshots"
                    sort={sort ?? { id: "created", direction: "descending" }}
                    onChange={(next) =>
                        onSortChange(
                            next.id === "created" && next.direction === "descending"
                                ? null
                                : next
                        )
                    }
                    options={[
                        { value: "created", label: "Created" },
                        { value: "size", label: "Logical size" },
                        { value: "verification", label: "Verification" },
                        { value: "protected", label: "Protected" },
                    ]}
                />
            )}
            <VirtualList
                label="Backup snapshots"
                rows={snapshots}
                getKey={(row) => row.id}
                {...(continuation ? { continuation } : {})}
                className="@container/entries"
                framed
                itemClassName="p-3 sm:px-4"
                renderItem={(row) => (
                    <DetailEntry
                        name={formatDateTime(row.createdAt)}
                        accessory={<SnapshotStatus snapshot={row} stale={unavailable} />}
                    >
                        <DetailFacts
                            inline
                            items={[
                                {
                                    label: "Logical size",
                                    value: formatMetric(row.sizeBytes, "bytes"),
                                },
                                {
                                    label: "Protected",
                                    value: protection(row.protected),
                                },
                            ]}
                        />
                    </DetailEntry>
                )}
            />
        </div>
    );
}
