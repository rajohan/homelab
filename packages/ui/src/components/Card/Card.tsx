import type { ComponentProps } from "react";

import { cn } from "../../lib/classNames";

export function Card({ className, ...props }: ComponentProps<"section">) {
    return (
        <section
            className={cn(
                "max-w-full min-w-0 rounded-xl border border-primary-700 bg-primary-800/80 p-5 shadow-sm shadow-black/10 sm:p-6",
                className
            )}
            {...props}
        />
    );
}
