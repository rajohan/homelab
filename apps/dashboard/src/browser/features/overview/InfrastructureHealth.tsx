import {
    Card,
    DataTable,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    buttonStyles,
    formatMetric,
} from "@homelab/ui";
import { Link } from "@tanstack/react-router";
import { Server } from "lucide-react";

import { MetricStat } from "../infrastructure/MetricStat";
import { ResourceStatus } from "../infrastructure/ResourceStatus";
import { ResourceUsage } from "../infrastructure/ResourceUsage";
import { useInfrastructure } from "../infrastructure/useInfrastructure";
import { ObservationBadge } from "../operations/ObservationBadge";

/**
 * Summarize monitoring without adding host and guest allocations or shared storage together.
 * @returns Physical resource visibility and application/probe health from the existing inventory.
 */
export function InfrastructureHealth() {
    const { query, inventory, stale, configured } = useInfrastructure();
    const hosts =
        inventory?.hosts.filter((host) => host.kind === "node" || host.kind === "host") ??
        [];
    const applications = inventory?.applications ?? [];
    const probes = inventory?.services.filter((item) => item.kind === "probe") ?? [];
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Infrastructure health"
                description="Hosts, applications and end-to-end service checks."
                icon={Server}
                actions={
                    <ObservationBadge
                        configured={configured}
                        available={Boolean(inventory)}
                        stale={stale}
                    />
                }
            />
            {query.isPending && <LoadingState label="Loading infrastructure…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {inventory && (
                <>
                    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <MetricStat
                            label="Hosts / guests"
                            value={
                                stale
                                    ? "—"
                                    : `${inventory.hosts.filter((host) => host.state === "healthy").length} / ${inventory.hosts.length}`
                            }
                        />
                        <MetricStat
                            label="Healthy applications"
                            value={
                                stale
                                    ? "—"
                                    : `${applications.filter((item) => item.state === "healthy").length} / ${applications.length}`
                            }
                        />
                        <MetricStat
                            label="Failed checks"
                            value={
                                stale
                                    ? "—"
                                    : probes.filter((item) => item.state === "unhealthy")
                                          .length
                            }
                        />
                        <MetricStat
                            label="Unknown applications"
                            value={
                                stale
                                    ? "—"
                                    : applications.filter(
                                          (item) => item.state === "unknown"
                                      ).length
                            }
                        />
                    </dl>
                    {hosts.length > 0 && (
                        <DataTable
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
                                    render: (host) =>
                                        formatMetric(
                                            stale ? null : host.cpuPercent,
                                            "percent"
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
                                            total={host.memoryTotal}
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
            <Link
                to="/infrastructure"
                className={buttonStyles({ variant: "secondary", className: "w-full" })}
            >
                View infrastructure
            </Link>
        </Card>
    );
}
