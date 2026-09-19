import { queryRefresh } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";

/**
 * Share inventory polling and freshness across Overview and Infrastructure.
 * @returns One cached observation with its request outcome and checked time.
 */
export function useInfrastructure() {
    const query = useQuery({
        queryKey: ["operations", "infrastructure", "inventory"],
        queryFn: async ({ signal }) => ({
            inventory: await api.infrastructure.inventory.query(undefined, { signal }),
            checkedAt: Date.now(),
        }),
        ...queryRefresh("fast"),
        retry: false,
    });
    const inventory = query.data?.inventory;
    const stale =
        query.isError ||
        !inventory ||
        Date.parse(inventory.capturedAt) < (query.data?.checkedAt ?? 0) - 180_000;
    return { query, inventory, stale };
}
