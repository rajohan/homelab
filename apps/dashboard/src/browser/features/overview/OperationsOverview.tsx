import { ErrorNotice, SectionHeader, SummaryStrip } from "@homelab/ui";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";

import { ResourceStatus } from "../infrastructure/ResourceStatus";
import { InfrastructureHealth } from "./InfrastructureHealth";
import { OverviewLink } from "./OverviewLink";
import { PrioritySummary } from "./PrioritySummary";
import { RecentActivity } from "./RecentActivity";
import { useOverviewReadings } from "./useOverviewReadings";

const rank = { unhealthy: 0, unknown: 1, stopped: 2, healthy: 3 };

/** Render live operational priorities, infrastructure and activity from independently refreshed domains.
 * @returns The authenticated overview with canonical detail links and explicit partial-data states.
 */
export function OperationsOverview() {
    const r = useOverviewReadings();
    const ratio = (rows: readonly { state: string }[]) =>
        r.inventory && rows.length > 0
            ? `${rows.filter((item) => item.state === "healthy").length} / ${rows.length}`
            : "—";
    const apps = (r.infra.inventory?.applications ?? [])
        .toSorted(
            (a, b) =>
                (r.infra.stale ? 0 : rank[a.state] - rank[b.state]) ||
                a.name.localeCompare(b.name)
        )
        .slice(0, 6);
    const count = (state: string) =>
        r.page?.counts.find((i) => i.state === state)?.count ?? 0;
    const operations = [
        {
            label: "Incidents",
            to: "/alerts",
            detail: r.alerts
                ? `${r.active} active · ${count("suppressed")} suppressed · ${count("resolved")} resolved`
                : "Current monitoring unavailable",
            error: r.incidents.error,
        },
        {
            label: "Backups",
            to: "/backups",
            detail: r.protection
                ? `${r.backupRows.filter((b) => b.state === "healthy").length} healthy · ${r.issueBackups.length} need attention · ${r.backupRows.filter((b) => b.state === "unknown").length} unknown`
                : "No current backup inventory",
            error: r.backups.error,
        },
        {
            label: "Updates",
            to: "/updates",
            detail:
                (r.sources?.length ?? 0) > 0
                    ? `${r.reports.length > 0 ? r.available : "—"} available · ${r.reports.length > 0 ? r.security : "—"} security · ${r.missingSources} missing or stale sources`
                    : "No current update inventory",
            error: r.updates.error,
        },
        {
            label: "Jobs",
            to: "/jobs",
            detail: r.queue
                ? `${r.jobCount("queued")} queued · ${r.jobCount("running")} running · ${r.jobCount("failed") + r.jobCount("timed_out")} failed or timed out in history`
                : "Queue status unavailable",
            error: r.worker.error,
        },
    ] as const;
    return (
        <div className="@container/overview min-w-0">
            <PrioritySummary readings={r} />
            <SummaryStrip
                items={[
                    { label: "Healthy hosts / guests", value: ratio(r.hosts) },
                    { label: "Healthy applications", value: ratio(r.apps) },
                    { label: "Healthy probes", value: ratio(r.probes) },
                    {
                        label: "Running jobs",
                        value: r.queue ? r.jobCount("running") : "—",
                    },
                ]}
            />
            <div className="mt-6 grid gap-7 @min-[56rem]/overview:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                <div className="min-w-0 space-y-6">
                    <InfrastructureHealth />
                    <section className="space-y-2">
                        <SectionHeader
                            title="Applications"
                            compactActions
                            actions={
                                <OverviewLink to="/applications">View all</OverviewLink>
                            }
                        />
                        <p className="text-xs text-primary-400">
                            {r.inventory
                                ? `${r.apps.filter((a) => a.state === "unknown").length} unknown applications · ${r.probes.filter((p) => p.state === "unhealthy").length} failed checks`
                                : "Current application health unavailable"}
                        </p>
                        <ul className="divide-y divide-primary-700 border-y border-primary-700">
                            {apps.map((app) => (
                                <li
                                    key={app.id}
                                    className="flex items-center justify-between gap-2 py-3"
                                >
                                    <span className="min-w-0 text-sm font-medium wrap-anywhere">
                                        {app.name}
                                        <span className="mt-0.5 block text-xs font-normal text-primary-400">
                                            {app.host}
                                        </span>
                                    </span>
                                    <ResourceStatus
                                        state={r.infra.stale ? "unknown" : app.state}
                                    />
                                </li>
                            ))}
                        </ul>
                        {apps.length === 0 && (
                            <p className="text-sm text-primary-400">
                                No applications reported.
                            </p>
                        )}
                    </section>
                </div>
                <div className="min-w-0 space-y-6 @min-[56rem]/overview:border-l @min-[56rem]/overview:border-primary-700 @min-[56rem]/overview:pl-6">
                    <RecentActivity />
                    <section className="space-y-2">
                        <SectionHeader title="Operations" />
                        <ul className="divide-y divide-primary-700 border-y border-primary-700">
                            {operations.map((item) => (
                                <li key={item.to}>
                                    <Link
                                        to={item.to}
                                        className="hover:text-workspace-accent flex min-h-11 items-center justify-between gap-3 rounded-sm py-3"
                                    >
                                        <span className="min-w-0">
                                            <strong className="block text-sm font-semibold">
                                                {item.label}
                                            </strong>
                                            <span className="text-xs wrap-anywhere text-primary-400">
                                                {item.detail}
                                            </span>
                                        </span>
                                        <ArrowUpRight
                                            size={16}
                                            className="shrink-0"
                                            aria-hidden="true"
                                        />
                                    </Link>
                                    {item.error && <ErrorNotice error={item.error} />}
                                </li>
                            ))}
                        </ul>
                    </section>
                </div>
            </div>
        </div>
    );
}
