import { AppErrorBoundary } from "@homelab/ui";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { IdentityBoundary } from "./identity/IdentityBoundary";
import type { createDashboardRouter } from "./router";

export function DashboardApp({
    router,
    queryClient,
}: {
    router: ReturnType<typeof createDashboardRouter>;
    queryClient: QueryClient;
}) {
    return (
        <AppErrorBoundary>
            <QueryClientProvider client={queryClient}>
                <IdentityBoundary>
                    <RouterProvider router={router} />
                </IdentityBoundary>
            </QueryClientProvider>
        </AppErrorBoundary>
    );
}
