import type { NotificationBulkInput } from "@homelab/contracts/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../api/client";
import { notificationQueryKey } from "./queries";

/**
 * Execute acknowledgement actions without retrying ambiguous network failures.
 * @returns Exact and bounded bulk actions with notification-only cache invalidation.
 */
export function useNotificationActions() {
    const queries = useQueryClient();
    const refresh = () => queries.invalidateQueries({ queryKey: notificationQueryKey });
    const acknowledge = useMutation({
        mutationKey: [...notificationQueryKey, "acknowledge"],
        mutationFn: (input: Parameters<typeof api.notifications.acknowledge.mutate>[0]) =>
            api.notifications.acknowledge.mutate(input),
        onSettled: refresh,
        retry: false,
    });
    const bulk = useMutation({
        mutationKey: [...notificationQueryKey, "acknowledgeBatch"],
        mutationFn: async (input: NotificationBulkInput) => {
            let affected = 0;
            for (let batch = 0; batch < 100; batch += 1) {
                const result = await api.notifications.acknowledgeBatch.mutate(input);
                affected += result.affected;
                if (!result.remaining) return affected;
                if (result.affected !== 100)
                    throw new Error(
                        "The notification action made no progress. Refresh before trying again."
                    );
            }
            throw new Error(
                "The first 10,000 notifications were processed. Refresh and repeat to continue."
            );
        },
        onSettled: refresh,
        retry: false,
    });
    return { acknowledge, bulk, pending: acknowledge.isPending || bulk.isPending };
}
