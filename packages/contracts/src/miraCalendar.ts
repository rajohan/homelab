import * as v from "valibot";

import { idSchema, versionedIdSchema } from "./operations";

const instant = v.pipe(v.string(), v.isoTimestamp());
const fields = {
    title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
    notes: v.pipe(v.string(), v.trim(), v.maxLength(8000)),
    location: v.pipe(v.string(), v.trim(), v.maxLength(240)),
    allDay: v.boolean(),
    startsAt: instant,
    endsAt: instant,
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
    )
);
export const calendarUpdateSchema = v.pipe(
    v.strictObject({ ...fields, ...versionedIdSchema.entries }),
    v.check((value) => validInterval(value), "Invalid calendar interval.")
);
export const calendarRangeSchema = v.pipe(
    v.strictObject({
        start: instant,
        end: instant,
        timeZone: v.pipe(
            v.string(),
            v.maxLength(100),
            v.check((zone) => {
                try {
                    new Intl.DateTimeFormat("en", { timeZone: zone });
                    return true;
                } catch {
                    return false;
                }
            }, "Use an IANA time zone.")
        ),
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
export type CalendarEvent = CalendarInput & {
    id: string;
    version: number;
    createdBy: "operator" | "mira";
};
