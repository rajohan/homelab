import {
    Badge,
    Card,
    ErrorNotice,
    LoadingState,
    PageHeader,
    queryRefresh,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { InfrastructureOverview } from "../features/infrastructure/InfrastructureOverview";

/**
 * Show the read-only infrastructure integration without coupling it to authentication.
 * @returns The current read-only inventory with loading, freshness and failure states.
 */
export function Infrastructure() {
    const query = useQuery({
        queryKey: ["operations", "infrastructure", "inventory"],
        queryFn: async ({ signal }) => ({
            inventory: await api.infrastructure.inventory.query(undefined, { signal }),
            checkedAt: Date.now(),
        }),
        ...queryRefresh("fast"),
        retry: false,
    });
    const inventory = query.data?.inventory;
    const stale =
        query.isError ||
        (inventory &&
            Date.parse(inventory.capturedAt) < (query.data?.checkedAt ?? 0) - 180_000);
    return (
        <>
            <PageHeader
                title="Infrastructure"
                description="Read-only monitoring data, collected independently of your browser."
                accessory={
                    inventory && (
                        <Badge tone={stale ? "warning" : "positive"}>
                            {stale ? "Stale inventory" : "Live inventory"}
                        </Badge>
                    )
                }
            />
            <div className="space-y-5">
                {query.isError && <ErrorNotice error={query.error} />}
                {query.isPending && <LoadingState label="Loading infrastructure…" />}
                {inventory && <InfrastructureOverview inventory={inventory} />}
                {!query.isPending && !inventory && !query.isError && (
                    <Card>
                        <p className="text-sm text-primary-400">
                            No resource inventory yet. The infrastructure job will collect
                            it from the configured monitoring endpoint.
                        </p>
                    </Card>
                )}
            </div>
        </>
    );
}
