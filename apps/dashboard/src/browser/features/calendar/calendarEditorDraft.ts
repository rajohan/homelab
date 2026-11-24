import type { CalendarEvent } from "@homelab/contracts/miraCalendar";
import { dateTimePickerValue } from "@homelab/ui";

import { localDay } from "./calendarDays";

/** Snapshot an appointment or initialize a new draft in the viewer's local calendar.
 * @param day - Selected calendar day for a new appointment.
 * @param event - Saved revision when editing an existing appointment.
 * @returns Initial field values and the optional identity used by edit and delete.
 */
export function calendarEditorDraft(day: Date, event?: CalendarEvent) {
    const morning = new Date(day);
    morning.setHours(9, 0, 0, 0);
    const now = new Date();
    const quarterHour = 15 * 60_000;
    const defaultStart =
        morning.toDateString() === now.toDateString() && morning <= now
            ? (Math.floor(now.getTime() / quarterHour) + 1) * quarterHour
            : morning.getTime();
    const start = event?.allDay
        ? localDay(Date.parse(event.startsAt))
        : (event?.startsAt ?? defaultStart);
    const end = event?.allDay
        ? localDay(Date.parse(event.endsAt) - 86_400_000)
        : (event?.endsAt ?? defaultStart + 3_600_000);
    return {
        target: event ? { id: event.id, version: event.version } : null,
        timeZone: event?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        title: event?.title ?? "",
        location: event?.location ?? "",
        notes: event?.notes ?? "",
        allDay: event?.allDay ?? false,
        start: dateTimePickerValue(start),
        end: dateTimePickerValue(end),
        operatorReminderAt: event?.operatorReminderAt ?? null,
        miraReminderAt: event?.miraReminderAt ?? null,
    };
}
