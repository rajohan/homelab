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
    readonly options: readonly { value: T; label: string; count?: number | string }[];
    readonly onChange: (value: T) => void;
}) {
    return (
        <fieldset
            aria-label={label}
            className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-primary-700 bg-primary-950 p-0.5"
        >
            {options.map((item) => (
                <button
                    key={item.value}
                    type="button"
                    aria-pressed={item.value === value}
                    onClick={() => onChange(item.value)}
                    className={cn(
                        "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium pointer-fine:min-h-8",
                        item.value === value
                            ? "bg-accent-900 text-accent-100 ring-1 ring-accent-400/40 ring-inset"
                            : "text-primary-400 hover:bg-primary-800 hover:text-primary-50"
                    )}
                >
                    {item.label}
                    {item.count !== undefined && (
                        <span className="text-xs tabular-nums opacity-80">
                            {item.count}
                        </span>
                    )}
                </button>
            ))}
        </fieldset>
    );
}
