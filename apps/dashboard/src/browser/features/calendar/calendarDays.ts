import type { CalendarEvent } from "@homelab/contracts/miraCalendar";

/** Convert a calendar date to its floating all-day storage instant.
 * @param date - Day in the viewer's local calendar.
 * @returns UTC midnight milliseconds representing that same date.
 */
export function floatingDay(date: Date) {
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Return a viewer-local date for a floating all-day instant.
 * @param instant - Absolute UTC midnight used to store a floating date.
 * @returns The matching local calendar day independent of browser offset.
 */
export function localDay(instant: number) {
    const date = new Date(instant);
    return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Select appointments intersecting one day, handling exclusive ends and DST.
 * @param events - Events returned by the shared calendar.
 * @param day - Calendar day in the viewer's time zone.
 * @returns All-day entries first, then timed events in chronological order.
 */
export function eventsOnDay(events: readonly CalendarEvent[], day: Date) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    return events
        .filter((event) => {
            const from = event.allDay ? floatingDay(start) : start.getTime();
            const until = event.allDay ? floatingDay(end) : end.getTime();
            return Date.parse(event.startsAt) < until && Date.parse(event.endsAt) > from;
        })
        .toSorted(
            (a, b) =>
                Number(b.allDay) - Number(a.allDay) ||
                a.startsAt.localeCompare(b.startsAt) ||
                a.title.localeCompare(b.title)
        );
}
