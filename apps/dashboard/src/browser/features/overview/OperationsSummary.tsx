import { ErrorNotice, formatDateTime, SectionPanel } from "@homelab/ui";
import { Link } from "@tanstack/react-router";
import { Archive, ChevronRight, Download, ListChecks, Radio } from "lucide-react";

import type { OverviewReadings } from "./useOverviewReadings";

const colors = {
    neutral: "text-primary-200",
    healthy: "text-emerald-300",
    warning: "text-amber-300",
    info: "text-accent-300",
};

type Reading = { value: string; detail: string; tone: keyof typeof colors };

function incidentReading(r: OverviewReadings): Reading {
    if (!r.alerts)
        return {
            value: "Unavailable",
            detail: "No current monitoring data",
            tone: "neutral",
        };
    const count = (state: string) =>
        r.alerts?.counts.find((i) => i.state === state)?.count ?? 0;
    return {
        value: r.active ? `${r.active} active` : "All clear",
        detail: [
            count("suppressed") > 0 && `${count("suppressed")} suppressed`,
            `${count("resolved")} resolved`,
        ]
            .filter(Boolean)
            .join(" · "),
        tone: r.active ? "warning" : "healthy",
    };
}

function backupReading(r: OverviewReadings): Reading {
    if (!r.protection || r.backupRows.length === 0)
        return {
            value: "Unavailable",
            detail: "No current backup tasks",
            tone: "neutral",
        };
    const healthy = r.backupRows.filter((b) => b.state === "healthy").length;
    const unknown = r.backupRows.filter((b) => b.state === "unknown").length;
    const latest = r.backupRows
        .flatMap((b) => (b.lastSuccessAt ? [b.lastSuccessAt] : []))
        .toSorted()
        .at(-1);
    const needsAttention = r.issueBackups.length;
    const issue = needsAttention > 0 || unknown > 0;
    const coverage = unknown ? `${unknown} unknown` : `${healthy} healthy`;
    return {
        value: needsAttention
            ? `${needsAttention} ${needsAttention === 1 ? "needs" : "need"} attention`
            : coverage,
        detail: [
            issue && `${healthy} healthy`,
            needsAttention > 0 && unknown > 0 && `${unknown} unknown`,
            latest && `Last success ${formatDateTime(latest)}`,
        ]
            .filter(Boolean)
            .join(" · "),
        tone: issue ? "warning" : "healthy",
    };
}

function updateReading(r: OverviewReadings): Reading {
    const missing = r.missingSources ?? 0;
    const coverage = `${missing} missing or stale ${missing === 1 ? "source" : "sources"}`;
    if (r.reports.length === 0)
        return {
            value: "Unavailable",
            detail: missing ? coverage : "No current update inventory",
            tone: "neutral",
        };
    const availabilityTone = r.available ? "info" : "healthy";
    return {
        value: `${r.available} available`,
        detail: [
            r.security ? `${r.security} security` : "No security updates reported",
            missing > 0 && coverage,
        ]
            .filter(Boolean)
            .join(" · "),
        tone: r.security || missing ? "warning" : availabilityTone,
    };
}

function jobReading(r: OverviewReadings): Reading {
    if (!r.queue)
        return { value: "Unavailable", detail: "No current queue data", tone: "neutral" };
    const queued = r.jobCount("queued"),
        running = r.jobCount("running");
    const failures = r.jobCount("failed") + r.jobCount("timed_out");
    const offline = r.queue.workers.every((worker) => !worker.online);
    const workerState = offline ? "Offline" : undefined;
    const condition = r.queue.control.paused ? "Paused" : workerState;
    const waiting = queued ? `${queued} queued` : "Idle";
    const activity = running ? `${running} running` : waiting;
    const activityTone = queued || running ? "info" : "neutral";
    return {
        value: condition ?? activity,
        detail: [
            condition && running > 0 && `${running} running`,
            (condition || running) && queued > 0 && `${queued} queued`,
            failures > 0
                ? `${failures} past failures or timeouts`
                : "No past failures or timeouts",
        ]
            .filter(Boolean)
            .join(" · "),
        tone: condition ? "warning" : activityTone,
    };
}

/** Show the current state of each operational domain and link to its detailed readings.
 * @param props - Independently refreshed observations, including any source errors.
 * @returns Four navigable summaries with secondary context from the same observations.
 */
export function OperationsSummary({
    readings: r,
}: {
    readonly readings: OverviewReadings;
}) {
    const items = [
        {
            label: "Incidents",
            to: "/alerts",
            icon: Radio,
            reading: incidentReading(r),
            query: r.incidents,
        },
        {
            label: "Backups",
            to: "/backups",
            icon: Archive,
            reading: backupReading(r),
            query: r.backups,
        },
        {
            label: "Updates",
            to: "/updates",
            icon: Download,
            reading: updateReading(r),
            query: r.updates,
        },
        {
            label: "Jobs",
            to: "/jobs",
            icon: ListChecks,
            reading: jobReading(r),
            query: r.worker,
        },
    ] as const;
    return (
        <SectionPanel icon={ListChecks} title="Operations">
            <ul className="flex flex-1 flex-col divide-y divide-primary-700">
                {items.map(({ label, to, icon: Icon, reading, query }) => (
                    <li key={to} className="flex flex-1 flex-col">
                        <Link
                            to={to}
                            className="group grid min-h-16 flex-1 grid-cols-[1.125rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-1 py-2.5 hover:bg-primary-800/70 focus-visible:outline-2 focus-visible:outline-accent-300"
                        >
                            <Icon
                                size={17}
                                className="text-primary-400 group-hover:text-accent-300"
                                aria-hidden="true"
                            />
                            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                <span className="text-sm font-semibold text-primary-50">
                                    {label}
                                </span>
                                <span
                                    className={`text-sm font-semibold tabular-nums ${query.isPending ? colors.neutral : colors[reading.tone]}`}
                                >
                                    {query.isPending ? "Checking…" : reading.value}
                                </span>
                            </div>
                            <ChevronRight
                                size={14}
                                className="text-primary-400 group-hover:text-accent-300"
                                aria-hidden="true"
                            />
                            {!query.isPending && reading.detail && (
                                <span className="col-start-2 col-end-4 text-xs leading-relaxed wrap-anywhere text-primary-400">
                                    {reading.detail}
                                </span>
                            )}
                        </Link>
                        {query.error && <ErrorNotice error={query.error} />}
                    </li>
                ))}
            </ul>
        </SectionPanel>
    );
}
