import { Fieldset } from "../Form/Fieldset";
import { Select } from "../Select/Select";

const hours = Array.from({ length: 24 }, (_, hour) => {
    const value = String(hour).padStart(2, "0");
    return { value, label: value };
});
const minutes = Array.from({ length: 60 }, (_, minute) => {
    const value = String(minute).padStart(2, "0");
    return { value, label: value };
});

/**
 * Choose a 24-hour time using keyboard-accessible hour and minute listboxes.
 * @returns A reusable time field without platform-native time inputs.
 */
export function TimePicker({
    label,
    value,
    onChange,
    disabled = false,
    error,
}: {
    readonly label: string;
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly disabled?: boolean;
    readonly error?: string | undefined;
}) {
    const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    const [hour = "00", minute = "00"] = valid ? value.split(":") : [];
    return (
        <Fieldset
            legend={label}
            disabled={disabled}
            {...(error === undefined ? {} : { error })}
        >
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                <Select
                    label={`${label}, hour`}
                    options={hours}
                    value={hour}
                    onChange={(next) => onChange(`${next}:${minute}`)}
                />
                <span aria-hidden="true" className="font-semibold text-primary-300">
                    :
                </span>
                <Select
                    label={`${label}, minute`}
                    options={minutes}
                    value={minute}
                    onChange={(next) => onChange(`${hour}:${next}`)}
                />
            </div>
        </Fieldset>
    );
}
