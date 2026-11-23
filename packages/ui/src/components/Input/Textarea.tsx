import { Textarea as HeadlessTextarea } from "@headlessui/react";
import { type ComponentProps, useContext } from "react";

import { cn } from "../../lib/classNames";
import { FormFieldInvalidContext } from "../../lib/formFieldContext";
import { fieldAppearance } from "./inputStyles";

/**
 * Render a multiline field with the same validation and appearance as shared inputs.
 * @returns An accessible textarea; callers provide a visible label or accessible name.
 */
export function Textarea({
    className,
    invalid,
    disabled,
    ref = null,
    ...props
}: Omit<ComponentProps<"textarea">, "autoFocus"> & { readonly invalid?: boolean }) {
    const inheritedInvalid = useContext(FormFieldInvalidContext);
    return (
        <HeadlessTextarea
            {...props}
            ref={ref}
            {...(disabled === undefined ? {} : { disabled })}
            invalid={invalid ?? inheritedInvalid}
            className={cn(fieldAppearance, "max-h-[40dvh] min-h-20 resize-y", className)}
        />
    );
}
