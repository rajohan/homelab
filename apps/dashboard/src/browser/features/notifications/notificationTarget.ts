import type { NotificationRecord } from "@homelab/contracts/notifications";
import { linkOptions } from "@tanstack/react-router";

/** Resolve first-party job outcomes and monitoring transitions to their recorded detail view.
 * @param notice - The delivered notification, including its immutable source and public destination.
 * @returns An internal route or null for an informational message with no destination.
 */
export function notificationTarget(notice: NotificationRecord) {
    if (!notice.destination) return null;
    if (notice.destination === "jobs" && notice.jobRunId)
        return linkOptions({ to: "/jobs", search: { run: notice.jobRunId } });
    if (notice.source === "alerts" && notice.destination === "alerts")
        return linkOptions({
            to: "/alerts",
            search: {
                notice: notice.id,
                view: notice.severity === "success" ? "resolved" : "current",
            },
        });
    return linkOptions({ to: `/${notice.destination}` as const });
}
