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
        neutral: "bg-[#eef1f5] text-[#526174]",
        positive: "bg-[#e9f4ee] text-[#28704a]",
        warning: "bg-[#fff3df] text-[#8c591c]",
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
