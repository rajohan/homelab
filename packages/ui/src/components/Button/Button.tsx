import { Button as HeadlessButton } from "@headlessui/react";
import type { ComponentProps } from "react";

import { cn } from "../../lib/classNames";

export function Button({
    className,
    disabled = false,
    ref = null,
    type = "button",
    ...props
}: Omit<ComponentProps<"button">, "autoFocus">) {
    return (
        <HeadlessButton
            disabled={disabled}
            ref={ref}
            type={type}
            className={cn(
                "inline-flex cursor-pointer items-center justify-center rounded-[7px] border border-[#c6d3e5] bg-[#f7f9fc] px-3.25 py-2 text-[0.8rem] font-semibold text-[#2a518b] data-disabled:cursor-not-allowed data-disabled:opacity-60 data-focus:outline-2 data-focus:outline-offset-4 data-focus:outline-[#587fcc] data-hover:bg-[#edf2f9]",
                className
            )}
            {...props}
        />
    );
}
