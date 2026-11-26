import type {
    NotificationBulkInput,
    NotificationFilter,
    NotificationSeverity,
} from "@homelab/contracts/notifications";
import {
    ActionGroup,
    ActivityPanel,
    Button,
    ChoiceBar,
    ConfirmDialog,
    EmptyState,
    ErrorNotice,
    LoadingState,
    ScrollList,
    Select,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Bell, CheckCheck, Trash2 } from "lucide-react";
import { useState } from "react";

import { NotificationItem } from "./NotificationItem";
import { notificationHistoryOptions } from "./queries";
import { useNotificationActions } from "./useNotificationActions";

/**
 * Browse and acknowledge a bounded notification inbox with server-side filters.
 * @returns Cursor-paginated history and explicit confirmation for clearing read items.
 */
export function NotificationPanel({ onClose }: { readonly onClose: () => void }) {
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
    const countStatus = query.isError
        ? "Counts unavailable"
        : "Loading notification counts…";
    return (
        <ActivityPanel
            title="Notifications"
            icon={Bell}
            onClose={onClose}
            summary={latest ? undefined : countStatus}
        >
            <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-[1_1_max-content]">
                    <ChoiceBar
                        fullWidth
                        size="field"
                        label="Notification read state"
                        value={state}
                        onChange={setState}
                        options={[
                            {
                                value: "all",
                                label: "All",
                                count: latest
                                    ? latest.unreadCount + latest.readCount
                                    : "—",
                            },
                            {
                                value: "unread",
                                label: "Unread",
                                count: latest?.unreadCount ?? "—",
                            },
                            {
                                value: "read",
                                label: "Read",
                                count: latest?.readCount ?? "—",
                            },
                        ]}
                    />
                </div>
                <div className="min-w-0 flex-auto">
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
            </div>
            {!clear && (actions.acknowledge.error || actions.bulk.error) && (
                <ErrorNotice error={actions.acknowledge.error ?? actions.bulk.error} />
            )}
            {query.isPending && <LoadingState label="Loading notifications…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {!query.isPending && !query.isError && rows.length === 0 && (
                <EmptyState compact icon={Bell} title="No matching notifications." />
            )}
            {rows.length > 0 && (
                <ScrollList
                    label="Notification history"
                    itemClassName="pb-0"
                    rows={rows}
                    getKey={(row) => row.id}
                    renderItem={(notification) => (
                        <NotificationItem
                            notification={notification}
                            pending={actions.pending}
                            onNavigate={onClose}
                            onAction={(id, action) =>
                                actions.acknowledge.mutate({ id, action })
                            }
                        />
                    )}
                    className="max-h-[min(30rem,50dvh)] min-h-0 shrink"
                    continuation={{
                        hasMore: query.hasNextPage,
                        loading: query.isFetchingNextPage,
                        refreshing: query.isRefetching,
                        error: query.isError ? query.error : undefined,
                        loadingLabel: "Loading older notifications…",
                        onLoadMore: () =>
                            void (query.isRefetchError
                                ? query.refetch()
                                : query.fetchNextPage()),
                    }}
                />
            )}
            <ActionGroup className="border-t border-primary-700 pt-3">
                <Button
                    variant="secondary"
                    disabled={actions.pending || !input || !latest?.readCount}
                    onClick={() => {
                        if (input) setClear({ ...input, action: "dismissRead" });
                    }}
                >
                    <Trash2 size={16} aria-hidden="true" />
                    Clear read
                </Button>
                <Button
                    busy={
                        actions.bulk.isPending &&
                        actions.bulk.variables?.action === "read"
                    }
                    busyLabel="Marking as read…"
                    disabled={actions.pending || !input || !latest?.unreadCount}
                    onClick={() => {
                        if (input) actions.bulk.mutate({ ...input, action: "read" });
                    }}
                >
                    <CheckCheck size={16} aria-hidden="true" />
                    Mark all as read
                </Button>
            </ActionGroup>
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
        </ActivityPanel>
    );
}
