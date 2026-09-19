import { queryRefresh } from "@homelab/ui";

import { api } from "../../api/client";

export const applicationInventoryOptions = {
    queryKey: ["operations", "applications", "inventory"] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.applications.inventory.query(undefined, { signal }),
    ...queryRefresh("fast"),
    retry: false,
};
