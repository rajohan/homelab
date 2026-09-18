import {
    Badge,
    Card,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    queryRefresh,
    formatDateTime,
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
                    <dl className="grid gap-4 sm:grid-cols-3">
                        <div>
                            <dt className="text-sm text-primary-400">
                                Reachable targets
                            </dt>
                            <dd className="mt-1 text-2xl font-semibold">
                                {snapshot.reachableTargets} / {snapshot.totalTargets}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-sm text-primary-400">
                                Unreachable targets
                            </dt>
                            <dd className="mt-1 text-2xl font-semibold">
                                {snapshot.totalTargets - snapshot.reachableTargets}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-sm text-primary-400">
                                Firing alert samples
                            </dt>
                            <dd className="mt-1 text-2xl font-semibold">
                                {snapshot.firingAlerts ?? "Not reported"}
                            </dd>
                        </div>
                    </dl>
                    <p className="text-sm text-primary-400">
                        Collected {formatDateTime(snapshot.capturedAt)}. Targets are
                        scrape endpoints, not a count of physical servers. Watchdog is
                        excluded.
                    </p>
                </>
            )}
            {!query.isPending && !query.isError && !snapshot && (
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    No snapshot yet. Configure the metrics endpoint and start the worker
                    to collect one.
                </p>
            )}
        </Card>
    );
}
