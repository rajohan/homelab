import type { ComponentProps } from "react";

import { cn } from "../../lib/classNames";

export function Card({ className, ...props }: ComponentProps<"section">) {
    return (
        <section
            className={cn(
                "rounded-xl border border-[#dfe5ed] bg-white p-5 shadow-[0_2px_3px_#17253503] sm:p-6.25",
                className
            )}
            {...props}
        />
    );
}
