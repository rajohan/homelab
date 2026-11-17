import { queryRefresh } from "@homelab/ui";
import { createTRPCClient, httpBatchLink, httpLink, splitLink } from "@trpc/client";
import superjson from "superjson";

import type { AppRouter } from "../../server/api/router";

const transport = {
    url: "/api/trpc",
    transformer: superjson,
    headers: { "X-Homelab-Passive": "1" },
};

export const api = createTRPCClient<AppRouter>({
    links: [
        splitLink({
            // Transcript refreshes must not wait for unrelated operational queries.
            condition: (operation) => operation.path.startsWith("mira.conversations."),
            true: httpLink(transport),
            false: httpBatchLink(transport),
        }),
    ],
});

export const systemStatusQuery = {
    queryKey: ["system", "status"] as const,
    /**
     * Fetch the passive system status for the dashboard query cache.
     * @returns The current system status response.
     */
    queryFn: () => api.system.status.query(),
    staleTime: 30_000,
    ...queryRefresh("slow"),
    retry: 1,
};
