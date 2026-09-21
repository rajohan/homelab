import type { TableSort } from "@homelab/contracts/tableSort";
import {
    DataTable,
    ErrorNotice,
    LoadingState,
    SearchInput,
    Select,
    queryRefresh,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import { UpdateAction } from "./UpdateAction";
import { UpdateStatus } from "./UpdateStatus";
import { updateVersion } from "./updateVersion";

/**
 * Browse a source's software with bounded network pages and shared virtual scrolling.
 * @param props - Configured source selected by the operator.
 * @returns Version comparison with separately authorized, confirmed installation controls.
 */
export function SoftwareUpdates({
    source,
    category = "software",
}: {
    readonly source: string;
    readonly category?: "software" | "toolchains";
}) {
    const [search, setSearch] = useState("");
    const [state, setState] = useState<"attention" | "all">("attention");
    const [sort, setSort] = useState<TableSort | null>(null);
    const query = useInfiniteQuery({
        queryKey: [
            "operations",
            "updates",
            source,
            search,
            state,
            ...(category === "toolchains" ? [category] : []),
            ...(sort ? [sort] : []),
        ],
        initialPageParam: {},
        queryFn: ({ pageParam, signal }) =>
            api.updates.list.query(
                {
                    source,
                    category,
                    search,
                    state,
                    ...pageParam,
                    ...(sort ? { sort } : {}),
                },
                { signal }
            ),
        getNextPageParam: (page) => {
            if (sort)
                return page.nextSortCursor ? { cursor: page.nextSortCursor } : undefined;
            return page.nextCursor ? { after: page.nextCursor } : undefined;
        },
        ...queryRefresh("normal"),
        retry: false,
    });
    const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
                <SearchInput
                    label="Search software"
                    clearLabel="Clear software search"
                    placeholder="Find a package or application…"
                    value={search}
                    onChange={setSearch}
                />
                <Select
                    label="Show"
                    value={state}
                    onChange={setState}
                    options={[
                        { value: "attention", label: "Updates and unchecked items" },
                        { value: "all", label: "All observed software" },
                    ]}
                />
            </div>
            {query.isPending && <LoadingState label="Loading software inventory…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {rows.length > 0 && (
                <DataTable
                    label={
                        category === "toolchains"
                            ? "Toolchain updates"
                            : "Software updates"
                    }
                    compact
                    rows={rows}
                    sort={sort}
                    onSortChange={setSort}
                    getKey={(item) => item.id}
                    columns={[
                        {
                            id: "name",
                            sortValue: (row) => row.name,
                            label: "Software",
                            mobile: "title",
                            render: (item) => (
                                <div>
                                    {item.name}
                                    {item.pinned && (
                                        <p className="text-xs text-primary-400">
                                            Digest pinned
                                        </p>
                                    )}
                                </div>
                            ),
                        },
                        {
                            id: "kind",
                            sortValue: (row) => row.kind,
                            label: "Type",
                            render: (item) => item.kind,
                        },
                        {
                            id: "installed",
                            sortValue: (row) => row.installed,
                            label: "Installed",
                            render: (item) => (
                                <span
                                    className="wrap-anywhere"
                                    title={item.image ?? item.installed}
                                >
                                    {updateVersion(item, "installed")}
                                </span>
                            ),
                        },
                        {
                            id: "available",
                            sortValue: (row) => row.available,
                            label: "Available",
                            render: (item) => (
                                <span
                                    className="wrap-anywhere"
                                    title={
                                        item.availableImage ?? item.available ?? undefined
                                    }
                                >
                                    {updateVersion(item, "available")}
                                </span>
                            ),
                        },
                        {
                            id: "status",
                            sortValue: (row) => row.status,
                            label: "Status",
                            render: (item) => (
                                <UpdateStatus
                                    item={item}
                                    stale={
                                        query.isError ||
                                        (query.data?.pages[0]?.stale ?? true)
                                    }
                                />
                            ),
                        },
                        {
                            id: "actions",
                            label: "Actions",
                            mobile: "footer-actions",
                            render: (item) =>
                                item.control ? (
                                    <UpdateAction
                                        item={item}
                                        control={item.control}
                                        disabled={
                                            query.isError ||
                                            (query.data?.pages[0]?.stale ?? true)
                                        }
                                    />
                                ) : null,
                        },
                    ]}
                    continuation={{
                        hasMore: query.hasNextPage,
                        loading: query.isFetching,
                        error: query.isError ? query.error : undefined,
                        loadingLabel: "Loading more software…",
                        onLoadMore: () =>
                            void (query.isRefetchError
                                ? query.refetch()
                                : query.fetchNextPage()),
                    }}
                />
            )}
            {query.data && rows.length === 0 && (
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    No matching software in this observation.
                </p>
            )}
        </div>
    );
}
