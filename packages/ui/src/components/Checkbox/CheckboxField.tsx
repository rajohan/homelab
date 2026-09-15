import { useId } from "react";

/**
 * Render a labelled checkbox with native keyboard and form semantics.
 * @returns The controlled checkbox and its clickable label.
 */
export function CheckboxField({
    label,
    checked,
    onChange,
    name,
    disabled = false,
}: {
    readonly label: string;
    readonly checked: boolean;
    readonly onChange: (checked: boolean) => void;
    readonly name?: string;
    readonly disabled?: boolean;
}) {
    const id = useId();
    return (
        <label
            htmlFor={id}
            className="flex cursor-pointer items-center gap-3 text-sm text-primary-200 has-disabled:cursor-not-allowed has-disabled:opacity-50"
        >
            <input
                id={id}
                type="checkbox"
                name={name}
                checked={checked}
                disabled={disabled}
                onChange={(event) => onChange(event.currentTarget.checked)}
                className="size-4 rounded border-primary-500 accent-accent-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400"
            />
            {label}
        </label>
    );
}
