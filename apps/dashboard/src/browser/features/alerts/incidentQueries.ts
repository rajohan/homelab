import type { TableSort } from "@homelab/contracts/tableSort";
import { queryRefresh } from "@homelab/ui";
import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "../../api/client";
/** Share incident paging, polling and sorting between the summary and incident history.
 * @param state - Current problems or resolved history.
 * @param sort - Optional server-side ordering.
 * @returns React Query options for the selected history.
 */
export function incidentOptions(state: "current" | "resolved", sort?: TableSort | null) {
    return infiniteQueryOptions({
        queryKey: ["operations", "alerts", state, ...(sort ? [sort] : [])],
        initialPageParam: {},
        queryFn: ({ pageParam, signal }) =>
            api.alerts.list.query(
                { state, ...pageParam, ...(sort ? { sort } : {}) },
                { signal }
            ),
        getNextPageParam: (page) => {
            if (sort)
                return page.nextSortCursor ? { cursor: page.nextSortCursor } : undefined;
            return page.nextCursor ? { before: page.nextCursor } : undefined;
        },
        ...queryRefresh("fast"),
        retry: false,
    });
}
