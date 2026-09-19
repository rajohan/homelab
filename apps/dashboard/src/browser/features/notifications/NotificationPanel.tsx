import type {
    NotificationBulkInput,
    NotificationFilter,
    NotificationSeverity,
} from "@homelab/contracts/notifications";
import {
    Button,
    ConfirmDialog,
    ErrorNotice,
    LoadingState,
    Select,
    VirtualList,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { NotificationItem } from "./NotificationItem";
import { notificationHistoryOptions } from "./queries";
import { useNotificationActions } from "./useNotificationActions";

/**
 * Browse and acknowledge a bounded notification inbox with server-side filters.
 * @returns Virtualized infinite history and explicit confirmation for clearing read items.
 */
export function NotificationPanel() {
    const [state, setState] = useState<NotificationFilter["state"]>("all");
    const [severity, setSeverity] = useState<NotificationSeverity | "all">("all");
    const [clear, setClear] = useState<NotificationBulkInput>();
    const filters = { state, ...(severity === "all" ? {} : { severity }) };
    const query = useInfiniteQuery(notificationHistoryOptions(filters));
    const actions = useNotificationActions();
    const latest = query.data?.pages[0];
    const rows = [
        ...new Map(
            (query.data?.pages.flatMap((page) => page.notifications) ?? []).map((row) => [
                row.id,
                row,
            ])
        ).values(),
    ];
    const input = latest?.through
        ? { through: latest.through, ...(severity === "all" ? {} : { severity }) }
        : undefined;
    return (
        <section aria-label="Notification inbox" className="flex min-h-0 flex-col gap-4">
            <div>
                <h2 className="text-lg font-semibold">Notifications</h2>
                <p className="mt-1 text-sm text-primary-400">
                    {latest
                        ? `${latest.unreadCount} unread · ${latest.readCount} read`
                        : "Loading notification counts…"}
                </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
                <Select
                    label="Notification read state"
                    value={state}
                    onChange={setState}
                    options={[
                        { value: "all", label: "All notifications" },
                        { value: "unread", label: "Unread" },
                        { value: "read", label: "Read" },
                    ]}
                />
                <Select
                    label="Notification severity"
                    value={severity}
                    onChange={setSeverity}
                    options={[
                        { value: "all", label: "All severities" },
                        { value: "info", label: "Info" },
                        { value: "success", label: "Success" },
                        { value: "warning", label: "Warning" },
                        { value: "error", label: "Error" },
                    ]}
                />
            </div>
            <div className="grid grid-cols-2 gap-2">
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={actions.pending || !input || !latest?.unreadCount}
                    onClick={() => {
                        if (input) actions.bulk.mutate({ ...input, action: "read" });
                    }}
                >
                    Mark all read
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={actions.pending || !input || !latest?.readCount}
                    onClick={() => {
                        if (input) setClear({ ...input, action: "dismissRead" });
                    }}
                >
                    Clear read
                </Button>
            </div>
            {!clear && (actions.acknowledge.error || actions.bulk.error) && (
                <ErrorNotice error={actions.acknowledge.error ?? actions.bulk.error} />
            )}
            {query.isPending && <LoadingState label="Loading notifications…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {!query.isPending && !query.isError && rows.length === 0 && (
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    No matching notifications.
                </p>
            )}
            {rows.length > 0 && (
                <VirtualList
                    label="Notifications"
                    scrollbarGap
                    rows={rows}
                    getKey={(row) => row.id}
                    renderItem={(notification) => (
                        <NotificationItem
                            notification={notification}
                            pending={actions.pending}
                            onAction={(id, action) =>
                                actions.acknowledge.mutate({ id, action })
                            }
                        />
                    )}
                    className="max-h-[min(30rem,50dvh)] min-h-0 shrink"
                    continuation={{
                        hasMore: query.hasNextPage,
                        loading: query.isFetching,
                        error: query.isError ? query.error : undefined,
                        loadingLabel: "Loading older notifications…",
                        onLoadMore: () =>
                            void (query.isRefetchError
                                ? query.refetch()
                                : query.fetchNextPage()),
                    }}
                />
            )}
            {clear && (
                <ConfirmDialog
                    title="Clear read notifications?"
                    description="Remove the read notifications matching this filter from your inbox. Other operators’ notifications are unchanged."
                    confirmLabel="Clear read"
                    onClose={() => setClear(undefined)}
                    onConfirm={async () => {
                        await actions.bulk.mutateAsync(clear);
                        setClear(undefined);
                    }}
                />
            )}
        </section>
    );
}
