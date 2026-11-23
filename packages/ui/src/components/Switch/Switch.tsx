import {
    Checkbox,
    Description,
    Field,
    Label,
    Switch as HeadlessSwitch,
} from "@headlessui/react";
import { Minus } from "lucide-react";
import { type ReactNode, useContext } from "react";

import { cn } from "../../lib/classNames";
import { FormFieldInvalidContext } from "../../lib/formFieldContext";

/**
 * Render a labelled switch, with a mixed state for controls that govern several settings.
 * @returns A controlled switch or tri-state checkbox with a shared track and label.
 */
export function Switch({
    checked,
    className,
    description,
    disabled,
    error,
    hideLabel = false,
    indeterminate,
    invalid,
    label,
    name,
    onChange,
}: {
    readonly checked: boolean;
    readonly className?: string;
    readonly description?: ReactNode;
    readonly disabled?: boolean;
    readonly error?: ReactNode;
    readonly hideLabel?: boolean;
    readonly indeterminate?: boolean;
    readonly invalid?: boolean;
    readonly label: ReactNode;
    readonly name?: string;
    readonly onChange: (checked: boolean) => void;
}) {
    const inheritedInvalid = useContext(FormFieldInvalidContext);
    const resolvedInvalid = (invalid ?? inheritedInvalid) || error !== undefined;
    const controlProps = {
        checked,
        onChange,
        ...(name === undefined ? {} : { name }),
        ...(disabled === undefined ? {} : { disabled }),
        "aria-invalid": resolvedInvalid,
        className: cn(
            "group relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-primary-500 bg-primary-700 shadow-sm transition-colors",
            "pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2.5",
            "data-hover:not-data-disabled:border-primary-300 data-hover:not-data-disabled:bg-primary-600",
            "data-checked:border-accent-300 data-checked:bg-accent-500 data-hover:data-checked:not-data-disabled:bg-accent-400",
            indeterminate && "border-accent-400 bg-accent-900",
            "data-focus:ring-2 data-focus:ring-accent-300 data-focus:ring-offset-2 data-focus:ring-offset-primary-950 data-focus:outline-none",
            "data-disabled:cursor-not-allowed data-disabled:opacity-55 motion-reduce:transition-none",
            resolvedInvalid && "border-red-500 ring-1 ring-red-400"
        ),
    };
    const thumb = (
        <span
            aria-hidden="true"
            className={cn(
                "flex size-4 translate-x-1 items-center justify-center rounded-full bg-white shadow transition-transform group-data-checked:translate-x-6 motion-reduce:transition-none",
                indeterminate && "translate-x-3.5"
            )}
        >
            {indeterminate && (
                <Minus size={12} strokeWidth={3} className="text-accent-900" />
            )}
        </span>
    );
    return (
        <Field
            className={cn(
                "flex w-full max-w-full min-w-0 items-start justify-between gap-3",
                className
            )}
            {...(disabled === undefined ? {} : { disabled })}
        >
            <div className={cn("min-w-0 flex-1", hideLabel && "sr-only")}>
                <Label className="block cursor-pointer text-sm font-medium wrap-break-word text-primary-200 data-disabled:cursor-not-allowed data-disabled:opacity-60">
                    {label}
                </Label>
                {description !== undefined && (
                    <Description className="mt-0.5 text-xs leading-5 wrap-break-word text-primary-400 data-disabled:opacity-60">
                        {description}
                    </Description>
                )}
                {error !== undefined && (
                    <Description className="mt-1 text-sm text-red-300">
                        {error}
                    </Description>
                )}
            </div>
            {indeterminate === undefined ? (
                <HeadlessSwitch {...controlProps}>{thumb}</HeadlessSwitch>
            ) : (
                <Checkbox
                    as="button"
                    type="button"
                    {...controlProps}
                    indeterminate={indeterminate}
                >
                    {thumb}
                </Checkbox>
            )}
        </Field>
    );
}
