import { Badge, Card, ErrorNotice, LoadingState, PageHeader } from "@homelab/ui";
import { Server } from "lucide-react";

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
                icon={Server}
                title="Infrastructure"
                accessory={
                    inventory && stale && <Badge tone="warning">Stale inventory</Badge>
                }
            />
            <div className="space-y-5">
                {query.isError && <ErrorNotice error={query.error} />}
                {query.isPending && <LoadingState label="Loading infrastructure…" />}
                <InfrastructureOverview
                    inventory={inventory}
                    stale={stale}
                    loading={query.isPending}
                />
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
