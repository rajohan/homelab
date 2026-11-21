import type { NotificationRecord } from "@homelab/contracts/notifications";

/** Present a first-party monitoring transition or keep the original publisher's wording.
 * @param notice - The inbox record including its source, title and full message.
 * @returns A readable title, an optional transition label and the affected host or message.
 */
export function describeNotification(notice: NotificationRecord) {
    if (notice.source === "alerts" && notice.destination === "alerts") {
        const resolved = notice.severity === "success";
        const rule =
            resolved && notice.title.startsWith("Resolved: ")
                ? notice.title.slice(10)
                : notice.title;
        const prefix = resolved
            ? `Monitoring no longer reports ${rule}`
            : `Monitoring reported ${rule}`;
        const suffix = resolved ? " as active." : ".";
        // Only shorten the first-party alert templates. Keep other publishers' text intact.
        if (
            notice.message === prefix + suffix ||
            (notice.message.startsWith(prefix + " on ") &&
                notice.message.endsWith(suffix))
        ) {
            const host = notice.message.slice(prefix.length + 4, -suffix.length);
            const title = rule
                .replaceAll(/([A-Z])([A-Z][a-z])/g, "$1 $2")
                .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2");
            return { title, label: resolved ? "Resolved" : "Reported", detail: host };
        }
    }
    return { title: notice.title, label: undefined, detail: notice.message };
}
