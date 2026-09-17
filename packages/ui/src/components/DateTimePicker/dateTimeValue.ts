import { formatDateTimeParts } from "../../lib/formatDateTime";

export interface DateTimePickerValue {
    readonly date: Date;
    readonly time: string;
}

/**
 * Split an instant into the viewer-local date and 24-hour minute selection.
 * @param value - An existing timestamp to edit.
 * @returns Values for the shared calendar and time controls.
 */
export function dateTimePickerValue(value: string | number | Date): DateTimePickerValue {
    const date = new Date(value);
    const [, time] = formatDateTimeParts(date);
    return { date, time: time.slice(0, 5) };
}

/**
 * Resolve a local date/time selection without silently normalizing invalid clock times.
 * @param value - Calendar day and HH:mm selected by the user.
 * @returns Epoch milliseconds, or NaN for invalid values including a DST clock gap.
 */
export function dateTimePickerTimestamp(value: DateTimePickerValue): number {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return Number.NaN;
    const [hour = 0, minute = 0] = value.time.split(":").map(Number);
    const date = new Date(value.date);
    date.setHours(hour, minute, 0, 0);
    if (date.getHours() !== hour || date.getMinutes() !== minute) return Number.NaN;
    return date.getTime();
}
