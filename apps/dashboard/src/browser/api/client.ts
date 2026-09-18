import { queryRefresh } from "@homelab/ui";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import type { AppRouter } from "../../server/api/router";

export const api = createTRPCClient<AppRouter>({
    links: [
        httpBatchLink({
            url: "/api/trpc",
            transformer: superjson,
            headers: { "X-Homelab-Passive": "1" },
        }),
    ],
});

export const systemStatusQuery = {
    queryKey: ["system", "status"] as const,
    queryFn: () => api.system.status.query(),
    staleTime: 30_000,
    ...queryRefresh("slow"),
    retry: 1,
};
