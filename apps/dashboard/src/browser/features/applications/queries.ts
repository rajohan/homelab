import { queryRefresh } from "@homelab/ui";

import { api } from "../../api/client";

export const applicationInventoryOptions = {
    queryKey: ["operations", "applications", "inventory"] as const,
    /**
     * Fetch the application inventory while honoring query cancellation.
     * @param context - Query execution context.
     * @param context.signal - Signal that cancels the inventory request.
     * @returns The current application inventory response.
     */
    queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.applications.inventory.query(undefined, { signal }),
    ...queryRefresh("fast"),
    retry: false,
};
