import type { ReactNode } from "react";

import { cn } from "../../lib/classNames";

/** Align a resource label, reading, denominator and meter to the shared tracks of a readings grid.
 * @returns A read-only measurement with its optional capacity.
 */
export function CapacityReading({
    label,
    value,
    capacity,
    percent,
    tone,
}: {
    readonly label: string;
    readonly value: string;
    readonly capacity?: ReactNode;
    readonly percent: number | null;
    readonly tone: "cpu" | "memory" | "storage";
}) {
    return (
        <div className="row-span-4 grid min-w-0 grid-rows-subgrid">
            <dt className="text-xs font-semibold text-primary-300">{label}</dt>
            <dd className="text-base leading-tight font-semibold tracking-tight wrap-anywhere tabular-nums @min-[19rem]/readings:text-xl @min-[26rem]/readings:text-2xl">
                {value}
            </dd>
            <dd aria-hidden={!capacity} className="text-xs text-primary-400 tabular-nums">
                {capacity}
            </dd>
            <dd
                aria-hidden="true"
                className="mt-1 h-1.5 overflow-hidden rounded-xs bg-primary-700 mask-[repeating-linear-gradient(90deg,black_0,black_calc(5%-1px),transparent_calc(5%-1px),transparent_5%)]"
            >
                {percent !== null && Number.isFinite(percent) && (
                    <div
                        className={cn(
                            "h-full",
                            {
                                cpu: "bg-accent-300",
                                memory: "bg-violet-300",
                                storage: "bg-teal-300",
                            }[tone]
                        )}
                        style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
                    />
                )}
            </dd>
        </div>
    );
}
