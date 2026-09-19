import { Badge } from "@homelab/ui";

/**
 * Share collection freshness presentation without mistaking it for resource health.
 * @returns A compact badge for unconfigured, missing, stale or current observations.
 */
export function ObservationBadge({
    configured,
    available,
    stale,
}: {
    readonly configured: boolean;
    readonly available: boolean;
    readonly stale: boolean;
}) {
    if (!configured) return <Badge tone="neutral">Not configured</Badge>;
    if (!available) return <Badge tone="warning">Awaiting data</Badge>;
    return (
        <Badge tone={stale ? "warning" : "positive"}>
            {stale ? "Stale data" : "Live data"}
        </Badge>
    );
}
