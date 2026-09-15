import { format, isValid } from "date-fns";

/**
 * Format a timestamp in the viewer's local timezone using the shared display convention.
 * @param value - An ISO timestamp, epoch milliseconds or Date.
 * @returns Separate day-first date and 24-hour time, or explicit unavailable placeholders.
 */
export function formatDateTimeParts(
    value: string | number | Date
): readonly [string, string] {
    const date = new Date(value);
    return isValid(date)
        ? [format(date, "dd.MM.yyyy"), format(date, "HH:mm:ss")]
        : ["Unavailable", "—"];
}

/**
 * Format a timestamp consistently across all browser interfaces.
 * @param value - An ISO timestamp, epoch milliseconds or Date.
 * @returns Local date and time separated by a middle dot.
 */
export function formatDateTime(value: string | number | Date): string {
    const [date, time] = formatDateTimeParts(value);
    return `${date} · ${time}`;
}
