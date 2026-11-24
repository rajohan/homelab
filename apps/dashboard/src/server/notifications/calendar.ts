import { publishNotification } from "@homelab/notifications";
import type { SQL } from "bun";

/** Deliver due personal reminders independently of Mira's login, pause or health.
 * @param client - Dashboard worker database.
 * @returns Number of notifications durably published with their delivery markers.
 */
export async function publishCalendarReminders(client: SQL): Promise<number> {
    return client.begin(async (query) => {
        const due = await query<
            { id: string; owner: string; title: string; version: number }[]
        >`
            SELECT id,owner,title,version FROM mira_calendar_events
            WHERE operator_reminder_at<=now() AND operator_reminded_at IS NULL
            ORDER BY operator_reminder_at,id LIMIT 20 FOR UPDATE SKIP LOCKED`;
        for (const event of due) {
            await publishNotification(
                query,
                "calendar",
                {
                    key: `${event.id}:${event.version}`,
                    title: "Calendar reminder",
                    message: event.title,
                    severity: "info",
                    destination: "calendar",
                },
                `human:${event.owner}`
            );
            await query`UPDATE mira_calendar_events SET operator_reminded_at=now() WHERE id=${event.id}`;
        }
        return due.length;
    });
}
