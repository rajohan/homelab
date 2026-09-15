import type { ComponentProps } from "react";

import { cn } from "../../lib/classNames";

export function Badge({
    className,
    tone = "neutral",
    ...props
}: ComponentProps<"span"> & {
    tone?: "neutral" | "positive" | "warning";
}) {
    const classes = {
        neutral: "bg-primary-700 text-primary-200",
        positive: "bg-emerald-950 text-emerald-300",
        warning: "bg-red-500/10 text-red-300",
    } as const;
    return (
        <span
            className={cn(
                "inline-flex items-center rounded-md px-2.25 py-1.25 text-[0.65rem] leading-[1.3] font-semibold whitespace-nowrap",
                classes[tone],
                className
            )}
            {...props}
        />
    );
}
