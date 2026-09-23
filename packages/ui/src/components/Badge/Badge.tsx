import type { ComponentProps } from "react";

import { cn } from "../../lib/classNames";

/**
 * Render a compact status label with a semantic visual tone.
 * @returns The component's rendered content for its current state.
 */
export function Badge({
    className,
    tone = "neutral",
    ...props
}: ComponentProps<"span"> & {
    tone?: "neutral" | "info" | "positive" | "warning" | "danger";
}) {
    const classes = {
        neutral: "bg-primary-700 text-primary-200",
        info: "bg-accent-500/10 text-accent-300",
        positive: "bg-emerald-950 text-emerald-300",
        warning: "bg-amber-500/10 text-amber-300",
        danger: "bg-red-500/10 text-red-300",
    } as const;
    return (
        <span
            className={cn(
                "inline-flex w-fit max-w-full items-center self-start rounded-md px-2.25 py-1.25 text-[0.65rem] leading-[1.3] font-semibold whitespace-nowrap",
                classes[tone],
                className
            )}
            {...props}
        />
    );
}
