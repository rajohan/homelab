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
export function SoftwareUpdates({ source }: { readonly source: string }) {
    const [search, setSearch] = useState("");
    const [state, setState] = useState<"attention" | "all">("attention");
    const query = useInfiniteQuery({
        queryKey: ["operations", "updates", source, search, state],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }) =>
            api.updates.list.query(
                { source, search, state, ...(pageParam ? { after: pageParam } : {}) },
                { signal }
            ),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        ...queryRefresh("slow"),
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
                    label="Software updates"
                    compact
                    rows={rows}
                    getKey={(item) => item.id}
                    columns={[
                        {
                            id: "name",
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
                        { id: "kind", label: "Type", render: (item) => item.kind },
                        {
                            id: "installed",
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
