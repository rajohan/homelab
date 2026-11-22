import { cn } from "../../lib/classNames";

/**
 * Offer a short set of mutually exclusive filters without opening a menu.
 * @returns Labelled buttons with the selected choice exposed to assistive technology.
 */
export function ChoiceBar<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    readonly label: string;
    readonly value: T;
    readonly options: readonly { value: T; label: string }[];
    readonly onChange: (value: T) => void;
}) {
    return (
        <fieldset aria-label={label} className="flex flex-wrap items-center gap-1">
            {options.map((item) => (
                <button
                    key={item.value}
                    type="button"
                    aria-pressed={item.value === value}
                    onClick={() => onChange(item.value)}
                    className={cn(
                        "min-h-11 cursor-pointer rounded-md px-3 text-sm font-medium sm:min-h-9",
                        item.value === value
                            ? "bg-accent-950 text-accent-200"
                            : "text-primary-400 hover:bg-primary-800 hover:text-primary-50"
                    )}
                >
                    {item.label}
                </button>
            ))}
        </fieldset>
    );
}
