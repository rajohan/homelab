import { Fieldset as HeadlessFieldset, Legend } from "@headlessui/react";
import { type ReactNode, useId } from "react";

import { cn } from "../../lib/classNames";
import { FormFieldInvalidContext } from "../../lib/formFieldContext";
import { fieldLabelStyles } from "./fieldLabelStyles";

/**
 * Group controls under a legend with shared disabled and validation state.
 * @returns The component's rendered content for its current state.
 */
export function Fieldset({
    legend,
    children,
    hideLegend = false,
    description,
    error,
    disabled = false,
    className,
}: {
    readonly legend: ReactNode;
    readonly hideLegend?: boolean;
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
            className={cn("m-0 min-w-0 border-0 p-0", className)}
        >
            <Legend className={hideLegend ? "sr-only" : fieldLabelStyles}>
                {legend}
            </Legend>
            <div className="min-w-0 space-y-3">
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
            </div>
        </HeadlessFieldset>
    );
}
