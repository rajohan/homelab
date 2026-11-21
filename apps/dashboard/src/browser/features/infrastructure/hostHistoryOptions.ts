import type { HistoryRange } from "@homelab/contracts/infrastructure";
import { queryRefresh } from "@homelab/ui";
import { queryOptions } from "@tanstack/react-query";

import { api } from "../../api/client";

/** Share the selected host's bounded history and polling policy between Overview and its inspector.
 * @param id - Monitored host identifier.
 * @param range - Requested historical window.
 * @param network - Optional interface whose I/O is requested.
 * @param disk - Optional disk whose I/O is requested.
 * @returns Cacheable query options scoped to the exact host and devices.
 */
export function hostHistoryOptions(
    id: string,
    range: HistoryRange,
    network: string | null,
    disk: string | null
) {
    return queryOptions({
        queryKey: ["operations", "infrastructure", "history", id, range, network, disk],
        queryFn: ({ signal }) =>
            api.infrastructure.history.query({ id, range, network, disk }, { signal }),
        staleTime: 60_000,
        ...queryRefresh("history"),
        retry: false,
    });
}
