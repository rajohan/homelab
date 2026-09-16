import { Fieldset as HeadlessFieldset, Legend } from "@headlessui/react";
import { useId, type ReactNode } from "react";

import { cn } from "../../lib/classNames";
import { FormFieldInvalidContext } from "../../lib/formFieldContext";

/**
 * Group controls under a legend with shared disabled and validation state.
 * @returns The component's rendered content for its current state.
 */
export function Fieldset({
    legend,
    children,
    description,
    error,
    disabled = false,
    className,
}: {
    readonly legend: ReactNode;
    readonly children: ReactNode;
    readonly description?: ReactNode;
    readonly error?: string;
    readonly disabled?: boolean;
    readonly className?: string;
}) {
    const descriptionId = useId();
    const errorId = useId();
    const describedBy = [
        description === undefined ? undefined : descriptionId,
        error === undefined ? undefined : errorId,
    ]
        .filter(Boolean)
        .join(" ");
    return (
        <HeadlessFieldset
            disabled={disabled}
            aria-describedby={describedBy || undefined}
            aria-invalid={error !== undefined || undefined}
            className={cn("m-0 min-w-0 space-y-3 border-0 p-0", className)}
        >
            <Legend className="text-sm font-semibold text-primary-200 data-disabled:opacity-60">
                {legend}
            </Legend>
            {description && (
                <p id={descriptionId} className="text-sm leading-6 text-primary-400">
                    {description}
                </p>
            )}
            <FormFieldInvalidContext value={error !== undefined}>
                {children}
            </FormFieldInvalidContext>
            {error !== undefined && (
                <p id={errorId} className="text-sm text-red-300">
                    {error}
                </p>
            )}
        </HeadlessFieldset>
    );
}
