import { Popover, queryRefresh } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";

import { api } from "../../api/client";
import { NotificationPanel } from "./NotificationPanel";
import { notificationQueryKey } from "./queries";

/**
 * Keep the notification count current without mounting or fetching full history.
 * @returns The global inbox trigger with an explicit unavailable state on read failures.
 */
export function NotificationCenter() {
    const query = useQuery({
        queryKey: [...notificationQueryKey, "count"],
        queryFn: ({ signal }) => api.notifications.list.query({ limit: 1 }, { signal }),
        ...queryRefresh("normal"),
        retry: false,
    });
    const count = query.isError ? undefined : query.data?.unreadCount;
    const countLabel =
        count === undefined ? "Notifications, loading" : `Notifications, ${count} unread`;
    const label = query.isError ? "Notifications, unread count unavailable" : countLabel;
    return (
        <Popover
            label={label}
            trigger={
                <>
                    <Bell size={20} aria-hidden="true" />
                    {count !== undefined && count > 0 && (
                        <span
                            aria-hidden="true"
                            className="absolute top-0 right-0 min-w-4 rounded-full bg-accent-600 px-1 text-center text-xs leading-4 font-semibold text-white"
                        >
                            {count > 99 ? "99+" : count}
                        </span>
                    )}
                    {query.isError && (
                        <span
                            aria-hidden="true"
                            className="absolute top-1 right-1 size-2 rounded-full bg-amber-400"
                        />
                    )}
                </>
            }
        >
            <NotificationPanel />
        </Popover>
    );
}
