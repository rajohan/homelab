import type { NotificationFilter } from "@homelab/contracts/notifications";
import { queryRefresh } from "@homelab/ui";

import { api } from "../../api/client";

export const notificationQueryKey = ["notifications"] as const;

/**
 * Share foreground refresh and cursor semantics between notification views.
 * @param filters - Current server-side acknowledgement and severity filters.
 * @returns Stable infinite-query options with no automatic mutation replay.
 */
export function notificationHistoryOptions(filters: NotificationFilter) {
    return {
        queryKey: [...notificationQueryKey, "history", filters],
        initialPageParam: undefined as string | undefined,
        queryFn: ({
            pageParam,
            signal,
        }: {
            pageParam: string | undefined;
            signal: AbortSignal;
        }) =>
            api.notifications.list.query(
                { ...filters, ...(pageParam ? { before: pageParam } : {}) },
                { signal }
            ),
        getNextPageParam: (
            page: Awaited<ReturnType<typeof api.notifications.list.query>>
        ) => page.nextCursor ?? undefined,
        ...queryRefresh("fast"),
        retry: false,
    };
}
