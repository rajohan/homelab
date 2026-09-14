import { Button as HeadlessButton } from "@headlessui/react";
import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";

export function Card({ className, ...props }: ComponentProps<"section">) {
    return (
        <section
            className={twMerge(
                "rounded-xl border border-[#dfe5ed] bg-white p-5 shadow-[0_2px_3px_#17253503] sm:p-[25px]",
                className
            )}
            {...props}
        />
    );
}

export function Badge({
    className,
    tone = "neutral",
    ...props
}: ComponentProps<"span"> & {
    tone?: "neutral" | "positive" | "warning";
}) {
    const classes = {
        neutral: "bg-[#eef1f5] text-[#526174]",
        positive: "bg-[#e9f4ee] text-[#28704a]",
        warning: "bg-[#fff3df] text-[#8c591c]",
    } as const;
    return (
        <span
            className={twMerge(
                "inline-flex items-center rounded-md px-[9px] py-[5px] text-[0.65rem] leading-[1.3] font-semibold whitespace-nowrap",
                classes[tone],
                className
            )}
            {...props}
        />
    );
}

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
            className={twMerge(
                "inline-flex cursor-pointer items-center justify-center rounded-[7px] border border-[#c6d3e5] bg-[#f7f9fc] px-[13px] py-2 text-[0.8rem] font-semibold text-[#2a518b] data-disabled:cursor-not-allowed data-disabled:opacity-60 data-focus:outline-2 data-focus:outline-offset-4 data-focus:outline-[#587fcc] data-hover:bg-[#edf2f9]",
                className
            )}
            {...props}
        />
    );
}
