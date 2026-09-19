import { queryRefresh } from "@homelab/ui";

import { api } from "../../api/client";

export const applicationInventoryOptions = {
    queryKey: ["operations", "applications", "inventory"] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => ({
        ...(await api.applications.inventory.query(undefined, { signal })),
        observedAt: Date.now(),
    }),
    ...queryRefresh("fast"),
    retry: false,
};
