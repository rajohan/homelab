import { AppErrorBoundary } from "@homelab/ui";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { IdentityBoundary } from "./identity/IdentityBoundary";
import type { createDashboardRouter } from "./router";

/**
 * Compose query state, identity verification, routing and top-level error handling.
 * @returns The component's rendered content for its current state.
 */
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
