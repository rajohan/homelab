import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import type { AppRouter } from "../../server/api/router";

const api = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
});

export const systemStatusQuery = {
    queryKey: ["system", "status"] as const,
    queryFn: () => api.system.status.query(),
    staleTime: 30_000,
    retry: 1,
};
