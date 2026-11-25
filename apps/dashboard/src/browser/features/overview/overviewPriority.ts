import { formatDateTime } from "@homelab/ui";

import { incompleteRestart, restartWorkload } from "../maintenance/restartNavigation";
import type { OverviewReadings } from "./useOverviewReadings";

type Priority = {
    tone: "danger" | "warning" | "clear" | "unknown";
    title: string;
    detail: string;
    to:
        | "/alerts"
        | "/backups"
        | "/infrastructure"
        | "/applications"
        | "/jobs"
        | "/updates";
    hash?: string;
    incident?: string;
    action: string;
};

/** Select a measured problem before incomplete coverage, and only report a clear result for observed domains.
 * @param r - Fresh observations and their independent availability.
 * @returns Current problems in priority order, or a single coverage summary when no problem is observed.
 */
export function overviewPriorities(r: OverviewReadings): Priority[] {
    const problems: Priority[] = [];
    const activeRows = r.alerts?.incidents.filter((i) => i.state === "active") ?? [];
    const urgent = activeRows.find((i) => i.severity === "error");
    const backup = r.issueBackups.find((b) => b.state === "failed") ?? r.issueBackups[0];
    const incident = urgent ?? activeRows[0];
    if (r.active > 0)
        problems.push({
            tone: urgent ? "danger" : "warning",
            title: incident?.name ?? `${r.active} active incidents`,
            detail: incident
                ? [
                      incident.host,
                      incident.service,
                      "Started " + formatDateTime(incident.startedAt),
                  ]
                      .filter(Boolean)
                      .join(" · ")
                : "Monitoring has reported a current problem.",
            to: "/alerts",
            ...(incident ? { incident: incident.id } : {}),
            action: incident ? "Inspect incident" : "Inspect incidents",
        });
    if (backup)
        problems.push({
            tone: backup.state === "failed" ? "danger" : "warning",
            title: `${backup.host} backup ${backup.state}`,
            detail: [
                backup.task,
                backup.lastSuccessAt
                    ? "Last successful backup " + formatDateTime(backup.lastSuccessAt)
                    : "No successful backup reported",
            ].join(" · "),
            to: "/backups",
            action: "Inspect backups",
        });
    if (backup && !urgent && r.active > 0) problems.reverse();
    const failedHost = r.hosts.find((host) => host.state === "unhealthy");
    const failedProbe = r.probes.find((probe) => probe.state === "unhealthy");
    const failedApp = r.apps.find((app) => app.state === "unhealthy");
    if (failedHost)
        problems.push({
            tone: "danger",
            title: `${failedHost.name} needs attention`,
            detail: "Host monitoring reported an unhealthy state.",
            to: "/infrastructure",
            hash: "hosts",
            action: "Inspect hosts",
        });
    if (failedProbe)
        problems.push({
            tone: "danger",
            title: `${failedProbe.name} check failed`,
            detail: failedProbe.host,
            to: "/infrastructure",
            hash: "services",
            action: "Inspect service checks",
        });
    if (failedApp)
        problems.push({
            tone: "danger",
            title: `${failedApp.name} needs attention`,
            detail: failedApp.host,
            to: "/infrastructure",
            hash: "applications",
            action: "Inspect monitored applications",
        });
    if (r.queue && (r.queue.control.paused || !r.queue.workers.some((w) => w.online)))
        problems.push({
            tone: "warning",
            title: r.queue.control.paused
                ? "Background work is paused"
                : "No worker is online",
            detail: `${r.jobCount("queued")} queued · ${r.jobCount("running")} running`,
            to: "/jobs",
            action: "Inspect jobs",
        });
    if (r.security > 0)
        problems.push({
            tone: "warning",
            title:
                r.security === 1
                    ? "Security update available"
                    : "Security updates available",
            detail: `${r.security} security ${r.security === 1 ? "update" : "updates"} reported by current sources.`,
            to: "/updates",
            action: "Inspect updates",
        });
    const hostNames = new Map<string, string>();
    for (const source of r.sources ?? []) {
        if (source.restart?.required && !source.restart.stale)
            hostNames.set(source.id.toLowerCase(), source.label);
    }
    const plans = r.restartPlans ?? [];
    const work = restartWorkload(plans);
    for (const plan of work.reboots)
        hostNames.set(plan.source.toLowerCase(), plan.host.label);
    const services = [...work.eligible, ...work.manual, ...work.unavailable];
    if (hostNames.size > 0 || services.length > 0) {
        const affectedHosts = [
            ...new Set([
                ...hostNames.values(),
                ...services.map((plan) => plan.host.label),
            ]),
        ].toSorted();
        const counts = [];
        if (hostNames.size > 0)
            counts.push(`${hostNames.size} ${hostNames.size === 1 ? "host" : "hosts"}`);
        if (services.length > 0)
            counts.push(
                `${services.length} ${services.length === 1 ? "service" : "services"}`
            );
        const names = new Intl.ListFormat("en", {
            style: "long",
            type: "conjunction",
        }).format(affectedHosts);
        problems.push({
            tone: "warning",
            title: `${counts.join(" and ")} ${hostNames.size + services.length === 1 ? "needs" : "need"} a restart`,
            detail: [
                names,
                work.eligible.length > 0 && `${work.eligible.length} in dashboard`,
                work.manual.length > 0 &&
                    `${work.manual.length} manual ${work.manual.length === 1 ? "service" : "services"}`,
                work.incompleteHosts > 0 && "Some restart checks are incomplete",
            ]
                .filter(Boolean)
                .join(" · "),
            to: "/updates",
            hash: "maintenance",
            action: "Review restarts",
        });
    }
    if (problems.length > 0)
        return problems.toSorted(
            (a, b) => Number(b.tone === "danger") - Number(a.tone === "danger")
        );
    if (r.pending)
        return [
            {
                tone: "unknown",
                title: "Checking your homelab",
                detail: "Waiting for current observations.",
                to: "/infrastructure",
                action: "View infrastructure",
            },
        ];
    if (
        !r.inventory ||
        r.hosts.length === 0 ||
        [...r.hosts, ...r.apps, ...r.probes].some((item) => item.state === "unknown")
    )
        return [
            {
                tone: "unknown",
                title: "Infrastructure visibility is incomplete",
                detail: "Some resources have no current health reading.",
                to: "/infrastructure",
                action: "Inspect infrastructure",
            },
        ];
    if (!r.alerts)
        return [
            {
                tone: "unknown",
                title: "Incident status is unavailable",
                detail: "Current monitoring coverage could not be confirmed.",
                to: "/alerts",
                action: "Inspect monitoring",
            },
        ];
    if (r.backupRows.length === 0 || r.backupRows.some((b) => b.state === "unknown"))
        return [
            {
                tone: "unknown",
                title: "Backup coverage is incomplete",
                detail: "Current protection could not be confirmed for all backup tasks.",
                to: "/backups",
                action: "Inspect backups",
            },
        ];
    if (r.reports.length === 0 || r.missingSources)
        return [
            {
                tone: "unknown",
                title: "Update inventory is incomplete",
                detail: "One or more software sources have no current report.",
                to: "/updates",
                action: "Inspect updates",
            },
        ];
    if (
        !r.restartPlans?.length ||
        r.restartPlans.some(incompleteRestart) ||
        r.sources?.some(
            (source) =>
                source.restart &&
                (source.restart.stale || source.restart.required === null)
        )
    )
        return [
            {
                tone: "unknown",
                title: "Restart status is incomplete",
                detail: "Some hosts or services have no current restart observation.",
                to: "/updates",
                hash: "maintenance",
                action: "Review restarts",
            },
        ];
    if (!r.queue)
        return [
            {
                tone: "unknown",
                title: "Worker status is unavailable",
                detail: "Current queue activity could not be confirmed.",
                to: "/jobs",
                action: "Inspect jobs",
            },
        ];
    return [
        {
            tone: "clear",
            title: "No active problems reported",
            detail: "No active incidents. Backup, update and worker observations are current.",
            to: "/infrastructure",
            action: "View infrastructure",
        },
    ];
}
