import { Input as HeadlessInput } from "@headlessui/react";
import { useContext, type ComponentProps } from "react";

import { cn } from "../../lib/classNames";
import { FormFieldInvalidContext } from "../../lib/formFieldContext";

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
            className={cn(
                "w-full min-w-0 rounded-lg border border-primary-500 bg-primary-950 px-3 py-2.5 text-base text-primary-50 shadow-sm transition-colors placeholder:text-primary-400 data-disabled:cursor-not-allowed data-disabled:opacity-60 data-focus:border-accent-400 data-focus:ring-2 data-focus:ring-accent-400 data-focus:outline-none data-hover:not-data-disabled:not-data-invalid:border-accent-400 data-invalid:border-red-500 data-focus:data-invalid:ring-red-500 motion-reduce:transition-none",
                className
            )}
        />
    );
}
