import type { ReactNode } from "react";

/**
 * Display one compact resource statistic with optional source context.
 * @returns A consistent labelled stat suitable for responsive summary grids.
 */
export function MetricStat({
    label,
    value,
    detail,
}: {
    readonly label: string;
    readonly value: ReactNode;
    readonly detail?: string;
}) {
    return (
        <div className="min-w-0 rounded-lg border border-primary-700 bg-primary-950/40 p-3">
            <dt className="text-xs text-primary-400">{label}</dt>
            <dd className="mt-1 text-lg font-semibold text-primary-50">{value}</dd>
            {detail && <dd className="mt-1 text-xs text-primary-400">{detail}</dd>}
        </div>
    );
}
