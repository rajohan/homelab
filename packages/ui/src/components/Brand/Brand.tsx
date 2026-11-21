import mark from "../../assets/rajohan-mark.svg" with { type: "text" };
import { cn } from "../../lib/classNames";

const logo = `data:image/svg+xml,${encodeURIComponent(mark)}`;

/**
 * Display the transparent Rajohan logo with a configurable product subtitle.
 * @returns The component's rendered content for its current state.
 */
export function Brand({
    className,
    subtitle = "Homelab",
    compact = false,
    size = "md",
}: {
    readonly className?: string;
    readonly subtitle?: string;
    readonly compact?: boolean;
    readonly size?: "sm" | "md";
}) {
    return (
        <span
            className={cn(
                "inline-flex items-center",
                size === "sm" ? "gap-2.5" : "gap-3",
                className
            )}
        >
            <img
                src={logo}
                alt=""
                width={40}
                height={40}
                className={cn("shrink-0", size === "sm" ? "size-8" : "size-10")}
            />
            <span className={compact ? "sr-only" : "min-w-0"}>
                <span
                    className={cn(
                        "block font-semibold tracking-tight text-primary-50",
                        size === "sm" ? "text-base leading-5" : "text-lg"
                    )}
                >
                    Rajohan
                </span>
                <span className="block text-xs font-medium text-primary-400">
                    {subtitle}
                </span>
            </span>
        </span>
    );
}
