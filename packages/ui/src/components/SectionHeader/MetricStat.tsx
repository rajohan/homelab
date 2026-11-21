import type { ReactNode } from "react";

import { cn } from "../../lib/classNames";

const valueTones = {
    neutral: "text-primary-50",
    positive: "text-emerald-300",
    warning: "text-amber-300",
    info: "text-accent-300",
} as const;

/**
 * Display one compact resource statistic with optional source context.
 * @returns A consistent labelled stat suitable for responsive summary grids.
 */
export function MetricStat({
    label,
    value,
    detail,
    className,
    toggle,
    attention = false,
    tone = attention ? "warning" : "neutral",
    appearance = "default",
}: {
    readonly appearance?: "default" | "reading" | "summary";
    readonly tone?: keyof typeof valueTones;
    readonly toggle?: {
        readonly label: string;
        readonly pressed: boolean;
        readonly onClick: () => void;
    };
    readonly className?: string;
    readonly attention?: boolean;
    readonly label: string;
    readonly value: ReactNode;
    readonly detail?: string;
}) {
    const summary = appearance === "summary";
    const quiet = summary && (value === 0 || value === "0" || value === "—");
    return (
        <div
            className={cn(
                "min-w-0",
                appearance === "default" && "border-t border-primary-700 py-2 pr-2",
                summary &&
                    "@container/metric relative grid min-h-11 grid-cols-[auto_minmax(0,1fr)] content-start items-baseline gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 @min-[30rem]/summary:px-3 @min-[30rem]/summary:py-2",
                toggle && "hover:bg-primary-700/55",
                toggle?.pressed && "bg-accent-950 ring-1 ring-accent-400/70 ring-inset",
                className
            )}
        >
            <dt
                className={cn(
                    appearance === "default"
                        ? "text-xs text-primary-400"
                        : "text-xs font-semibold text-primary-300",
                    summary &&
                        "col-span-full row-start-2 min-w-0 text-xs leading-4 font-medium text-pretty wrap-anywhere @min-[12rem]/metric:col-span-1 @min-[12rem]/metric:col-start-2 @min-[12rem]/metric:row-start-1 @min-[12rem]/metric:text-sm"
                )}
            >
                {toggle ? (
                    <button
                        type="button"
                        aria-label={toggle.label}
                        aria-pressed={toggle.pressed}
                        onClick={toggle.onClick}
                        className="cursor-pointer text-left text-accent-300 underline decoration-accent-300/55 underline-offset-4 after:absolute after:inset-0 after:rounded-md hover:decoration-current focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent-300"
                    >
                        {label}
                    </button>
                ) : (
                    label
                )}
            </dt>
            <dd
                className={cn(
                    "mt-1 font-semibold tracking-tight tabular-nums",
                    appearance === "reading"
                        ? "text-base leading-tight wrap-anywhere @min-[19rem]/readings:text-xl @min-[26rem]/readings:text-2xl"
                        : "text-xl",
                    summary &&
                        "col-span-full col-start-1 row-start-1 mt-0 max-w-full text-xl leading-tight wrap-anywhere @min-[12rem]/metric:col-span-1 @min-[12rem]/metric:text-2xl",
                    quiet ? "text-primary-400" : valueTones[tone]
                )}
            >
                {summary && typeof value === "number" ? value.toLocaleString() : value}
            </dd>
            {detail && (
                <dd
                    className={cn(
                        "mt-1 text-xs text-primary-400",
                        summary && "col-span-full"
                    )}
                >
                    {detail}
                </dd>
            )}
        </div>
    );
}
