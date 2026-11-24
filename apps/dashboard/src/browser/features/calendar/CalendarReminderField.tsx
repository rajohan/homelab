import { DateTimePicker, FormField, Select } from "@homelab/ui";

import { reminderChoices, type ReminderSelection } from "./calendarReminder";

/** Choose one calendar recipient's lead time or custom local date and time.
 * @param props - Recipient label, current selection, validation and change handler.
 * @returns The shared selection control and a date/time picker for custom reminders.
 */
export function CalendarReminderField({
    label,
    description,
    selection,
    onChange,
    error,
}: {
    label: string;
    description: string;
    selection: ReminderSelection;
    onChange: (selection: ReminderSelection) => void;
    error?: string | undefined;
}) {
    return (
        <div className="min-w-0 space-y-2">
            <FormField label={label} description={description} error={error}>
                <Select
                    options={reminderChoices}
                    value={selection.timing}
                    onChange={(timing) => onChange({ ...selection, timing })}
                />
            </FormField>
            {selection.timing === "custom" && (
                <DateTimePicker
                    label={`${label} on`}
                    value={selection.custom}
                    onChange={(custom) => onChange({ timing: "custom", custom })}
                />
            )}
        </div>
    );
}
