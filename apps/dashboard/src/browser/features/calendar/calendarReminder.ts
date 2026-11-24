import { previousCalendarDayTimestamp } from "@homelab/contracts/miraCalendar";
import {
    dateTimePickerTimestamp,
    type DateTimePickerValue,
    dateTimePickerValue,
} from "@homelab/ui";

export const reminderChoices = [
    { value: "off", label: "Off" },
    { value: "start", label: "At the start" },
    { value: "15m", label: "15 minutes before" },
    { value: "30m", label: "30 minutes before" },
    { value: "1h", label: "1 hour before" },
    { value: "1d", label: "1 day before" },
    { value: "custom", label: "Choose date and time…" },
] as const;

export type ReminderTiming = (typeof reminderChoices)[number]["value"];
export interface ReminderSelection {
    timing: ReminderTiming;
    custom: DateTimePickerValue;
    savedCustom?: number;
}

/** Resolve a preset in the event's time zone, or return an explicit custom instant.
 * @param selection - Timing chosen for one recipient.
 * @param start - Local start of the appointment, including local midnight for an all-day event.
 * @param timeZone - Stored IANA zone used for calendar-day arithmetic.
 * @returns Epoch milliseconds, null when off, or NaN for an invalid clock time.
 */
export function reminderInstant(
    selection: ReminderSelection,
    start: number,
    timeZone: string
) {
    switch (selection.timing) {
        case "off": {
            return null;
        }
        case "start": {
            return start;
        }
        case "15m": {
            return start - 15 * 60_000;
        }
        case "30m": {
            return start - 30 * 60_000;
        }
        case "1h": {
            return start - 3_600_000;
        }
        case "1d": {
            return previousCalendarDayTimestamp(start, timeZone);
        }
        case "custom": {
            return selection.savedCustom ?? dateTimePickerTimestamp(selection.custom);
        }
    }
}

/** Restore the matching timing preset for an existing appointment.
 * @param value - Stored reminder instant, or null for a recipient without a reminder.
 * @param start - Viewer-local start instant of the event.
 * @param timeZone - Stored IANA zone used to recognize the previous calendar day.
 * @returns Editable selection, retaining the saved date for custom schedules.
 */
export function reminderSelection(
    value: string | null | undefined,
    start: number,
    timeZone: string
): ReminderSelection {
    const custom = dateTimePickerValue(value ?? start);
    if (!value) return { timing: "off", custom };
    const instant = Date.parse(value);
    const preset = reminderChoices.find(
        ({ value: timing }) =>
            timing !== "custom" &&
            reminderInstant({ timing, custom }, start, timeZone) === instant
    );
    return { timing: preset?.value ?? "custom", custom, savedCustom: instant };
}
