import { formatDateTime } from "@homelab/ui";

import type { OverviewReadings } from "./useOverviewReadings";

type Priority = {
    tone: "warning" | "clear" | "unknown";
    title: string;
    detail: string;
    to:
        | "/alerts"
        | "/backups"
        | "/infrastructure"
        | "/applications"
        | "/jobs"
        | "/updates";
    action: string;
};

/** Select a measured problem before incomplete coverage, and only report a clear result for observed domains.
 * @param r - Fresh observations and their independent availability.
 * @returns The headline and its existing drill-down destination.
 */
export function overviewPriority(r: OverviewReadings): Priority {
    const activeRows = r.alerts?.incidents.filter((i) => i.state === "active") ?? [];
    const urgent = activeRows.find((i) => i.severity === "error");
    const backup = r.issueBackups.find((b) => b.state === "failed") ?? r.issueBackups[0];
    const incident = urgent ?? activeRows[0];
    if (urgent || (!backup && r.active > 0))
        return {
            tone: "warning",
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
            action: "Inspect incidents",
        };
    if (backup)
        return {
            tone: "warning",
            title: `${backup.host} backup ${backup.state}`,
            detail: [
                backup.task,
                backup.lastSuccessAt
                    ? "Last successful backup " + formatDateTime(backup.lastSuccessAt)
                    : "No successful backup reported",
            ].join(" · "),
            to: "/backups",
            action: "Inspect backups",
        };
    const failedHost = r.hosts.find((host) => host.state === "unhealthy");
    const failedProbe = r.probes.find((probe) => probe.state === "unhealthy");
    const failedApp = r.apps.find((app) => app.state === "unhealthy");
    if (failedHost)
        return {
            tone: "warning",
            title: `${failedHost.name} needs attention`,
            detail: "Host monitoring reported an unhealthy state.",
            to: "/infrastructure",
            action: "Inspect infrastructure",
        };
    if (failedProbe)
        return {
            tone: "warning",
            title: `${failedProbe.name} check failed`,
            detail: failedProbe.host,
            to: "/infrastructure",
            action: "Inspect infrastructure",
        };
    if (failedApp)
        return {
            tone: "warning",
            title: `${failedApp.name} needs attention`,
            detail: failedApp.host,
            to: "/applications",
            action: "Inspect applications",
        };
    if (r.queue && (r.queue.control.paused || !r.queue.workers.some((w) => w.online)))
        return {
            tone: "warning",
            title: r.queue.control.paused
                ? "Background work is paused"
                : "No worker is online",
            detail: `${r.jobCount("queued")} queued · ${r.jobCount("running")} running`,
            to: "/jobs",
            action: "Inspect jobs",
        };
    if (r.security > 0)
        return {
            tone: "warning",
            title: "Security updates available",
            detail: `${r.security} security updates reported by current sources.`,
            to: "/updates",
            action: "Inspect updates",
        };
    if (r.pending)
        return {
            tone: "unknown",
            title: "Checking your homelab",
            detail: "Waiting for current observations.",
            to: "/infrastructure",
            action: "View infrastructure",
        };
    if (
        !r.inventory ||
        r.hosts.length === 0 ||
        [...r.hosts, ...r.apps, ...r.probes].some((item) => item.state === "unknown")
    )
        return {
            tone: "unknown",
            title: "Infrastructure visibility is incomplete",
            detail: "Some resources have no current health reading.",
            to: "/infrastructure",
            action: "Inspect infrastructure",
        };
    if (!r.alerts)
        return {
            tone: "unknown",
            title: "Incident status is unavailable",
            detail: "Current monitoring coverage could not be confirmed.",
            to: "/alerts",
            action: "Inspect monitoring",
        };
    if (r.backupRows.length === 0 || r.backupRows.some((b) => b.state === "unknown"))
        return {
            tone: "unknown",
            title: "Backup coverage is incomplete",
            detail: "Current protection could not be confirmed for all backup tasks.",
            to: "/backups",
            action: "Inspect backups",
        };
    if (r.reports.length === 0 || r.missingSources)
        return {
            tone: "unknown",
            title: "Update inventory is incomplete",
            detail: "One or more software sources have no current report.",
            to: "/updates",
            action: "Inspect updates",
        };
    if (!r.queue)
        return {
            tone: "unknown",
            title: "Worker status is unavailable",
            detail: "Current queue activity could not be confirmed.",
            to: "/jobs",
            action: "Inspect jobs",
        };
    return {
        tone: "clear",
        title: "No active problems reported",
        detail: "The latest monitoring, backup and worker observations are available.",
        to: "/infrastructure",
        action: "View infrastructure",
    };
}
