import {
    DataTable,
    ErrorNotice,
    formatMetric,
    LoadingState,
    ReadingBar,
    SectionHeader,
} from "@homelab/ui";

import { ResourceStatus } from "../infrastructure/ResourceStatus";
import { ResourceUsage } from "../infrastructure/ResourceUsage";
import { useInfrastructure } from "../infrastructure/useInfrastructure";
import { ObservationBadge } from "../operations/ObservationBadge";
import { OverviewLink } from "./OverviewLink";

/**
 * Summarize monitoring without adding host and guest allocations or shared storage together.
 * @returns Physical resource visibility and application/probe health from the existing inventory.
 */
export function InfrastructureHealth() {
    const { query, inventory, stale, configured } = useInfrastructure();
    const hosts =
        inventory?.hosts.filter((host) => host.kind === "node" || host.kind === "host") ??
        [];
    return (
        <section className="min-w-0 space-y-3">
            <SectionHeader
                title="Hosts"
                compactActions
                badge={
                    <ObservationBadge
                        configured={configured}
                        available={Boolean(inventory)}
                        stale={stale}
                    />
                }
                actions={<OverviewLink to="/infrastructure">Infrastructure</OverviewLink>}
            />
            {query.isPending && <LoadingState label="Loading infrastructureâ€¦" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {inventory && (
                <>
                    {hosts.length > 0 && (
                        <DataTable
                            className="rounded-none border-x-0"
                            label="Physical host resources"
                            compact
                            rows={hosts}
                            getKey={(host) => host.id}
                            columns={[
                                {
                                    id: "name",
                                    sortValue: (row) => row.name,
                                    label: "Host",
                                    mobile: "title",
                                    render: (host) => host.name,
                                },
                                {
                                    id: "state",
                                    sortValue: (row) => (stale ? null : row.state),
                                    label: "Status",
                                    render: (host) => (
                                        <ResourceStatus
                                            state={stale ? "unknown" : host.state}
                                        />
                                    ),
                                },
                                {
                                    id: "cpu",
                                    sortValue: (row) => (stale ? null : row.cpuPercent),
                                    label: "CPU",
                                    render: (host) => (
                                        <div className="space-y-1.5">
                                            <span className="tabular-nums">
                                                {formatMetric(
                                                    stale ? null : host.cpuPercent,
                                                    "percent"
                                                )}
                                            </span>
                                            <ReadingBar
                                                percent={stale ? null : host.cpuPercent}
                                            />
                                        </div>
                                    ),
                                },
                                {
                                    id: "memory",
                                    sortValue: (row) => (stale ? null : row.memoryUsed),
                                    label: "Memory",
                                    mobile: "wide",
                                    width: "w-48",
                                    render: (host) => (
                                        <ResourceUsage
                                            singleLine
                                            used={stale ? null : host.memoryUsed}
                                            total={stale ? null : host.memoryTotal}
                                        />
                                    ),
                                },
                            ]}
                        />
                    )}
                </>
            )}
            {!query.isPending && !query.isError && !inventory && (
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    No infrastructure observation is available.
                </p>
            )}
            {inventory && hosts.length === 0 && (
                <p className="text-sm text-primary-400">No physical hosts reported.</p>
            )}
        </section>
    );
}
