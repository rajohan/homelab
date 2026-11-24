import { TZDate } from "@date-fns/tz";
import * as v from "valibot";

import { idSchema, versionedIdSchema } from "./operations";

const instant = v.pipe(v.string(), v.isoTimestamp());
export const calendarTimeZoneSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(100),
    v.check((zone) => {
        if (/^[+-]/.test(zone)) return false;
        try {
            new Intl.DateTimeFormat("en", { timeZone: zone });
            return true;
        } catch {
            return false;
        }
    }, "Use an IANA time zone.")
);
const fields = {
    title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
    notes: v.pipe(v.string(), v.trim(), v.maxLength(8000)),
    location: v.pipe(v.string(), v.trim(), v.maxLength(240)),
    allDay: v.boolean(),
    startsAt: instant,
    endsAt: instant,
    timeZone: v.optional(calendarTimeZoneSchema),
    operatorReminderAt: v.optional(v.nullable(instant)),
    miraReminderAt: v.optional(v.nullable(instant)),
};

/** Resolve the end of a timed event or a floating date in its source zone.
 * @param value - Stored interval with its optional IANA time zone.
 * @returns Epoch milliseconds at the exclusive end, using UTC−12 for legacy floating dates.
 */
export function calendarEndTimestamp(value: {
    allDay: boolean;
    endsAt: string;
    timeZone?: string | null | undefined;
}) {
    const end = new Date(value.endsAt);
    if (!value.allDay) return end.getTime();
    if (!value.timeZone) return end.getTime() + 12 * 3_600_000;
    const year = end.getUTCFullYear();
    const month = end.getUTCMonth();
    const day = end.getUTCDate();
    const local = new TZDate(year, month, day, value.timeZone);
    // Date's numeric constructor maps years 0–99 to 1900–1999.
    if (year >= 0 && year < 100) local.setFullYear(year, month, day);
    return local.getTime();
}
/** Resolve a reminder one calendar day before an event in its original IANA zone.
 * @param start - Appointment start in epoch milliseconds.
 * @param timeZone - Appointment's stored time zone.
 * @returns Epoch milliseconds, retaining the local clock time across a DST transition.
 */
export function previousCalendarDayTimestamp(start: number, timeZone: string) {
    const date = new TZDate(start, timeZone);
    return date.setDate(date.getDate() - 1);
}

const validReminders = (value: {
    endsAt: string;
    allDay: boolean;
    timeZone?: string | undefined;
    operatorReminderAt?: string | null | undefined;
    miraReminderAt?: string | null | undefined;
}) => {
    const end = calendarEndTimestamp(value);
    if (value.operatorReminderAt && Date.parse(value.operatorReminderAt) > end)
        return false;
    if (!value.miraReminderAt) return true;
    const at = Date.parse(value.miraReminderAt);
    return value.allDay && value.timeZone ? at < end : at <= end;
};
const validInterval = (value: { startsAt: string; endsAt: string; allDay: boolean }) => {
    const start = Date.parse(value.startsAt);
    const end = Date.parse(value.endsAt);
    return (
        end > start &&
        (!value.allDay || (start % 86_400_000 === 0 && end % 86_400_000 === 0))
    );
};
export const calendarCreateSchema = v.pipe(
    v.strictObject(fields),
    v.check(
        (value) => validInterval(value),
        "Choose an end after the start. All-day dates use midnight UTC with an exclusive end."
    ),
    v.check(
        (value) => validReminders(value),
        "Choose reminder times no later than the end of the event."
    )
);
export const calendarUpdateSchema = v.pipe(
    v.strictObject({ ...fields, ...versionedIdSchema.entries }),
    v.check((value) => validInterval(value), "Invalid calendar interval."),
    v.check(
        (value) => validReminders(value),
        "Choose reminder times no later than the end of the event."
    )
);
export const calendarRangeSchema = v.pipe(
    v.strictObject({
        start: instant,
        end: instant,
        timeZone: calendarTimeZoneSchema,
        after: v.optional(v.strictObject({ startsAt: instant, id: idSchema })),
    }),
    v.check(
        ({ start, end }) =>
            Date.parse(end) > Date.parse(start) &&
            Date.parse(end) - Date.parse(start) <= 93 * 86_400_000,
        "Choose a range of up to 93 days."
    )
);
export type CalendarInput = v.InferOutput<typeof calendarCreateSchema>;
export type CalendarRange = v.InferOutput<typeof calendarRangeSchema>;
export type CalendarEvent = Omit<CalendarInput, "timeZone"> & {
    id: string;
    version: number;
    createdBy: "operator" | "mira";
    timeZone: string | null;
    operatorReminderAt: string | null;
    miraReminderAt: string | null;
};
