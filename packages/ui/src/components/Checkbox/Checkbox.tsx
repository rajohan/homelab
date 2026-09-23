import { Checkbox as HeadlessCheckbox } from "@headlessui/react";
import { Check } from "lucide-react";

import { cn } from "../../lib/classNames";

/**
 * Render a compact controlled checkbox with shared pointer, focus and check styling.
 * @param props - Accessible label, selection state and optional disabled state.
 * @returns A keyboard-operable checkbox with an explicitly white checkmark.
 */
export function Checkbox({
    checked,
    disabled = false,
    label,
    onChange,
}: {
    readonly checked: boolean;
    readonly disabled?: boolean;
    readonly label: string;
    readonly onChange: (checked: boolean) => void;
}) {
    return (
        <HeadlessCheckbox
            as="button"
            type="button"
            checked={checked}
            disabled={disabled}
            onChange={onChange}
            aria-label={label}
            className={cn(
                "group inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border border-primary-500 bg-primary-800 transition-colors",
                "data-hover:not-data-checked:not-data-disabled:border-accent-400 data-hover:not-data-checked:not-data-disabled:bg-primary-700",
                "data-checked:border-accent-500 data-checked:bg-accent-500 data-hover:data-checked:not-data-disabled:border-accent-400 data-hover:data-checked:not-data-disabled:bg-accent-400",
                "data-disabled:cursor-not-allowed data-disabled:opacity-55 motion-reduce:transition-none",
                "data-focus:ring-2 data-focus:ring-accent-300 data-focus:ring-offset-2 data-focus:ring-offset-primary-950 data-focus:outline-none"
            )}
        >
            <Check
                aria-hidden="true"
                strokeWidth={3}
                className="pointer-events-none size-3.5 text-white opacity-0 group-data-checked:opacity-100"
            />
        </HeadlessCheckbox>
    );
}
