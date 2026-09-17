import { DatePicker } from "../DatePicker/DatePicker";
import { Fieldset } from "../Form/Fieldset";
import { TimePicker } from "../TimePicker/TimePicker";
import type { DateTimePickerValue } from "./dateTimeValue";

/**
 * Compose the shared calendar and 24-hour time selectors as one validated group.
 * @returns A responsive date/time field without native browser picker controls.
 */
export function DateTimePicker({
    label,
    value,
    onChange,
    minimumDate,
    error,
    disabled = false,
}: {
    readonly label: string;
    readonly value: DateTimePickerValue;
    readonly onChange: (value: DateTimePickerValue) => void;
    readonly minimumDate?: Date;
    readonly error?: string | undefined;
    readonly disabled?: boolean;
}) {
    return (
        <Fieldset
            legend={label}
            disabled={disabled}
            {...(error === undefined ? {} : { error })}
        >
            <div className="grid min-w-0 grid-cols-1 items-start gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <DatePicker
                    label="Date (DD.MM.YYYY)"
                    value={value.date}
                    {...(minimumDate === undefined ? {} : { minimumDate })}
                    disabled={disabled}
                    onChange={(date) => onChange({ ...value, date })}
                />
                <TimePicker
                    label="Time (24-hour)"
                    value={value.time}
                    disabled={disabled}
                    onChange={(time) => onChange({ ...value, time })}
                />
            </div>
        </Fieldset>
    );
}
