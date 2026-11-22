import {
    Badge,
    Card,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    queryRefresh,
    SectionHeader,
    SummaryStrip,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react";

import { api } from "../../api/client";

/**
 * Display the latest worker snapshot, retaining its timestamp and explicit stale state.
 * @returns A reusable infrastructure summary that never treats missing data as healthy.
 */
export function InfrastructureSummary() {
    const query = useQuery({
        queryKey: ["operations", "infrastructure"],
        queryFn: async ({ signal }) => ({
            snapshot: await api.infrastructure.summary.query(undefined, { signal }),
            checkedAt: Date.now(),
        }),
        ...queryRefresh("normal"),
        retry: false,
    });
    const snapshot = query.data?.snapshot;
    const stale =
        query.isError ||
        (snapshot !== null &&
            snapshot !== undefined &&
            Date.parse(snapshot.capturedAt) < (query.data?.checkedAt ?? 0) - 180_000);
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Monitoring summary"
                description="Collected in the background from your Prometheus-compatible metrics service."
                icon={Server}
                actions={
                    snapshot && (
                        <Badge tone={stale ? "warning" : "positive"}>
                            {stale ? "Stale data" : "Recent snapshot"}
                        </Badge>
                    )
                }
            />
            {query.isPending && <LoadingState label="Loading monitoring summary…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {snapshot && (
                <>
                    <SummaryStrip
                        label="Monitoring counts"
                        items={[
                            {
                                label: "Reachable targets",
                                value: `${snapshot.reachableTargets} / ${snapshot.totalTargets}`,
                            },
                            {
                                label: "Unreachable targets",
                                value: snapshot.totalTargets - snapshot.reachableTargets,
                                attention:
                                    !stale &&
                                    snapshot.totalTargets > snapshot.reachableTargets,
                            },
                            {
                                label: "Firing alert samples",
                                value: snapshot.firingAlerts ?? "Not reported",
                                attention: !stale && (snapshot.firingAlerts ?? 0) > 0,
                            },
                        ]}
                    />
                    <p className="text-sm text-primary-400">
                        Collected {formatDateTime(snapshot.capturedAt)}. Targets are
                        scrape endpoints, not a count of physical servers. Watchdog is
                        excluded.
                    </p>
                </>
            )}
            {!query.isPending && !query.isError && !snapshot && (
                <p className="rounded-lg border border-primary-700 bg-surface-empty p-4 text-sm text-primary-400">
                    No snapshot yet. Configure the metrics endpoint and start the worker
                    to collect one.
                </p>
            )}
        </Card>
    );
}
