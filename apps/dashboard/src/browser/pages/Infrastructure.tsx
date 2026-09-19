import { Badge, Card, ErrorNotice, LoadingState, PageHeader } from "@homelab/ui";

import { InfrastructureOverview } from "../features/infrastructure/InfrastructureOverview";
import { useInfrastructure } from "../features/infrastructure/useInfrastructure";

/**
 * Show the read-only infrastructure integration without coupling it to authentication.
 * @returns The current read-only inventory with loading, freshness and failure states.
 */
export function Infrastructure() {
    const { query, inventory, stale } = useInfrastructure();
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
