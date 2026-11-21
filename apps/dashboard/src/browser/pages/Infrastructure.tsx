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
    const unknown =
        inventory?.applications.filter((item) => item.state === "unknown").length ?? 0;
    const failedApps =
        inventory?.applications.filter((item) => item.state === "unhealthy").length ?? 0;
    const failedProbes =
        inventory?.services.filter(
            (item) => item.kind === "probe" && item.state === "unhealthy"
        ).length ?? 0;
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
                {!stale && (failedApps > 0 || unknown > 0 || failedProbes > 0) && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                        {(failedApps > 0 || unknown > 0) && (
                            <a
                                className="rounded text-amber-300 underline"
                                href="#applications"
                            >
                                {[
                                    failedApps > 0 && `${failedApps} unhealthy`,
                                    unknown > 0 && `${unknown} unknown`,
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </a>
                        )}
                        {failedProbes > 0 && (
                            <a
                                className="rounded text-amber-300 underline"
                                href="#services"
                            >
                                {failedProbes} failed{" "}
                                {failedProbes === 1 ? "probe" : "probes"}
                            </a>
                        )}
                    </div>
                )}
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
