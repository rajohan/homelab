import type { BackupGroup } from "@homelab/contracts/backups";
import type { TableSort } from "@homelab/contracts/tableSort";
import {
    Badge,
    ErrorNotice,
    LoadingState,
    Modal,
    formatMetric,
    queryRefresh,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import { MetricStat } from "../infrastructure/MetricStat";
import { SnapshotTable } from "./SnapshotTable";

/**
 * Inspect retained snapshot metadata with automatic bounded continuation, never archive access.
 * @returns Group metadata and a single scrollable snapshot table inside the shared modal.
 */
export function SnapshotDetails({
    group,
    stale,
    onClose,
}: {
    readonly group: BackupGroup;
    readonly stale: boolean;
    readonly onClose: () => void;
}) {
    const [sort, setSort] = useState<TableSort | null>(null);
    const query = useInfiniteQuery({
        queryKey: ["operations", "snapshots", group.id, ...(sort ? [sort] : [])],
        initialPageParam: {},
        queryFn: ({ pageParam, signal }) =>
            api.backups.snapshots.query(
                { groupId: group.id, ...pageParam, ...(sort ? { sort } : {}) },
                { signal }
            ),
        getNextPageParam: (page) => {
            if (sort)
                return page.nextSortCursor ? { cursor: page.nextSortCursor } : undefined;
            return page.nextCursor ? { before: page.nextCursor } : undefined;
        },
        ...queryRefresh("normal"),
        retry: false,
    });
    const rows = query.data?.pages.flatMap((page) => page.snapshots) ?? [];
    const unavailable = stale || query.isError || (query.data?.pages[0]?.stale ?? true);
    return (
        <Modal
            size="wide"
            title={group.name}
            description="Snapshot sizes, protection and recorded verification results."
            onClose={onClose}
        >
            <div className="space-y-4">
                <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <MetricStat label="Datastore" value={group.datastore} />
                    <MetricStat label="Namespace" value={group.namespace || "Root"} />
                    <MetricStat label="Snapshots" value={group.snapshotCount} />
                    <MetricStat
                        label="Latest snapshot size"
                        value={formatMetric(group.latestSizeBytes, "bytes")}
                    />
                </dl>
                <p className="text-sm text-primary-400">
                    Logical size before deduplication and compression.
                </p>
                {query.isPending && <LoadingState label="Loading snapshots…" />}
                {query.isError && <ErrorNotice error={query.error} />}
                {unavailable && <Badge tone="warning">Snapshot status unavailable</Badge>}
                {rows.length > 0 ? (
                    <SnapshotTable
                        snapshots={rows}
                        sort={sort}
                        onSortChange={setSort}
                        unavailable={unavailable}
                        continuation={{
                            hasMore: query.hasNextPage,
                            loading: query.isFetching,
                            error: query.isError ? query.error : undefined,
                            onLoadMore: () =>
                                void (query.isRefetchError
                                    ? query.refetch()
                                    : query.fetchNextPage()),
                            loadingLabel: "Loading snapshots…",
                        }}
                    />
                ) : (
                    !query.isPending && (
                        <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                            No snapshots are available for this backup group.
                        </p>
                    )
                )}
            </div>
        </Modal>
    );
}
