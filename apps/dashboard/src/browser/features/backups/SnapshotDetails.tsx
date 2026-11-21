import type { BackupGroup } from "@homelab/contracts/backups";
import type { TableSort } from "@homelab/contracts/tableSort";
import {
    Badge,
    DetailFacts,
    DetailSection,
    ErrorNotice,
    formatMetric,
    LoadingState,
    Modal,
    queryRefresh,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Archive, Layers } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { SnapshotList } from "./SnapshotList";

/**
 * Inspect retained snapshot metadata with automatic bounded continuation, never archive access.
 * @returns Group metadata and a single scrollable snapshot list inside the shared modal.
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
                <DetailSection icon={Archive} title="Backup group">
                    <DetailFacts
                        items={[
                            { label: "Datastore", value: group.datastore },
                            { label: "Namespace", value: group.namespace || "Root" },
                            { label: "Snapshots", value: group.snapshotCount },
                            {
                                label: "Latest snapshot size",
                                value: formatMetric(group.latestSizeBytes, "bytes"),
                                detail: "Before deduplication and compression",
                            },
                        ]}
                    />
                </DetailSection>
                <DetailSection icon={Layers} title="Snapshots">
                    {query.isPending && <LoadingState label="Loading snapshots…" />}
                    {query.isError && <ErrorNotice error={query.error} />}
                    {unavailable && (
                        <Badge tone="warning">Snapshot status unavailable</Badge>
                    )}
                    {rows.length > 0 ? (
                        <SnapshotList
                            snapshots={rows}
                            total={group.snapshotCount}
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
                            <p className="text-sm text-primary-400">
                                No snapshots are available for this backup group.
                            </p>
                        )
                    )}
                </DetailSection>
            </div>
        </Modal>
    );
}
