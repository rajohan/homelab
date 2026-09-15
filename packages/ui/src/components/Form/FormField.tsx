import { Description, Field, Label } from "@headlessui/react";
import { useContext, type ReactNode } from "react";

import { FormFieldInvalidContext } from "../../lib/formFieldContext";

export function FormField({
    label,
    children,
    description,
    error,
    disabled,
    className,
}: {
    readonly label: ReactNode;
    readonly children: ReactNode;
    readonly description?: ReactNode;
    readonly error?: string;
    readonly disabled?: boolean;
    readonly className?: string;
}) {
    const inheritedInvalid = useContext(FormFieldInvalidContext);
    return (
        <Field {...(disabled === undefined ? {} : { disabled })} className={className}>
            <Label className="mb-1.5 block text-sm font-medium text-primary-200 data-disabled:opacity-60">
                {label}
            </Label>
            <FormFieldInvalidContext value={error !== undefined || inheritedInvalid}>
                {children}
            </FormFieldInvalidContext>
            {description && (
                <Description className="mt-1.5 text-xs leading-5 text-primary-400">
                    {description}
                </Description>
            )}
            {error !== undefined && (
                <Description className="mt-1.5 text-sm text-red-300">{error}</Description>
            )}
        </Field>
    );
}
