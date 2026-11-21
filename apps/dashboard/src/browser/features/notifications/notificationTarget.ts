import type { NotificationRecord } from "@homelab/contracts/notifications";
import { linkOptions } from "@tanstack/react-router";

/** Resolve first-party monitoring transitions to their exact occurrence from either inbox view.
 * @param notice - The delivered notification, including its immutable source and public destination.
 * @returns An internal route or null for an informational message with no destination.
 */
export function notificationTarget(notice: NotificationRecord) {
    if (!notice.destination) return null;
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
