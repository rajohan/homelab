import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { Check, ChevronsUpDown } from "lucide-react";
import { useContext, type ReactNode } from "react";

import { cn } from "../../lib/classNames";
import { FormFieldInvalidContext } from "../../lib/formFieldContext";
import { inputStyles } from "../Input/inputStyles";

export interface SelectOption<T extends string> {
    readonly value: T;
    readonly label: ReactNode;
    readonly disabled?: boolean;
}

/**
 * Select one value with shared styling and Headless UI keyboard navigation.
 * @returns A controlled listbox with a bounded, anchored option panel.
 */
export function Select<T extends string>({
    label,
    options,
    value,
    onChange,
    disabled,
}: {
    readonly label?: string;
    readonly options: readonly SelectOption<T>[];
    readonly value: T;
    readonly onChange: (value: T) => void;
    readonly disabled?: boolean;
}) {
    const invalid = useContext(FormFieldInvalidContext);
    return (
        <Listbox
            value={value}
            onChange={onChange}
            invalid={invalid}
            {...(disabled === undefined ? {} : { disabled })}
        >
            <ListboxButton
                aria-label={label}
                className={cn(
                    inputStyles,
                    "flex items-center justify-between gap-3 text-left"
                )}
            >
                <span className="min-w-0 truncate">
                    {options.find((option) => option.value === value)?.label}
                </span>
                <ChevronsUpDown
                    size={16}
                    aria-hidden="true"
                    className="shrink-0 text-primary-400"
                />
            </ListboxButton>
            <ListboxOptions
                anchor={{ to: "bottom start", gap: 4, padding: 8 }}
                modal={false}
                className="z-70 max-h-64 w-(--button-width) max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg border border-primary-600 bg-primary-900 p-1 text-sm shadow-xl shadow-black/35 outline-none"
            >
                {options.map((option) => (
                    <ListboxOption
                        key={option.value}
                        value={option.value}
                        disabled={option.disabled ?? false}
                        className="group flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-primary-200 select-none data-disabled:cursor-not-allowed data-disabled:opacity-50 data-focus:bg-primary-700 data-focus:text-primary-50"
                    >
                        <Check
                            size={14}
                            aria-hidden="true"
                            className="invisible shrink-0 text-accent-300 group-data-selected:visible"
                        />
                        <span className="truncate">{option.label}</span>
                    </ListboxOption>
                ))}
            </ListboxOptions>
        </Listbox>
    );
}
