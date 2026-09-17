import { Input as HeadlessInput } from "@headlessui/react";
import { useContext, type ComponentProps } from "react";

import { cn } from "../../lib/classNames";
import { FormFieldInvalidContext } from "../../lib/formFieldContext";
import { inputStyles } from "./inputStyles";

/**
 * A label-independent input; callers supply a visible label or an accessible name.
 * @returns A styled Headless UI input.
 */
export function Input({
    className,
    disabled,
    ref = null,
    invalid,
    type = "text",
    ...props
}: Omit<ComponentProps<"input">, "autoFocus"> & { readonly invalid?: boolean }) {
    const inheritedInvalid = useContext(FormFieldInvalidContext);
    return (
        <HeadlessInput
            {...props}
            {...(disabled === undefined ? {} : { disabled })}
            invalid={
                invalid ??
                (props["aria-invalid"] === true ||
                    props["aria-invalid"] === "true" ||
                    inheritedInvalid)
            }
            ref={ref}
            type={type}
            className={cn(inputStyles, className)}
        />
    );
}
