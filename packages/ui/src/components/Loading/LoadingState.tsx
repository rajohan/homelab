import { LoaderCircle } from "lucide-react";

import { cn } from "../../lib/classNames";
import { LoadingDots } from "./LoadingDots";

const sizes = { sm: "min-h-24", md: "min-h-40", lg: "min-h-64" } as const;

export function LoadingState({
    label = "Loading…",
    size = "md",
    className,
}: {
    readonly label?: string;
    readonly size?: keyof typeof sizes;
    readonly className?: string;
}) {
    return (
        <output
            aria-busy="true"
            aria-label={label}
            className={cn(
                "flex w-full flex-col items-center justify-center gap-3 text-sm text-primary-400",
                sizes[size],
                className
            )}
        >
            <LoaderCircle
                size={24}
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
            />
            <LoadingDots label={label} />
        </output>
    );
}
