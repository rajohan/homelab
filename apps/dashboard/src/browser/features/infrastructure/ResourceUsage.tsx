import { formatMetric, ReadingBar, utilization } from "@homelab/ui";

/**
 * Display measured capacity without implying missing or zero capacity is healthy.
 * @returns A compact usage value, denominator and visual utilization indicator.
 */
export function ResourceUsage({
    used,
    total,
    description,
    singleLine = false,
}: {
    readonly used: number | null;
    readonly total: number | null;
    readonly description?: string;
    readonly singleLine?: boolean;
}) {
    const percent = utilization(used, total);
    return (
        <div className="@container min-w-0 space-y-1.5">
            <p className={singleLine ? "whitespace-nowrap tabular-nums" : "tabular-nums"}>
                <span className="whitespace-nowrap">{formatMetric(used, "bytes")}</span>{" "}
                <span
                    className={
                        singleLine
                            ? "text-primary-400"
                            : "whitespace-nowrap text-primary-400 @max-[11rem]:block"
                    }
                >
                    / {formatMetric(total, "bytes")}
                </span>
            </p>
            <ReadingBar
                percent={percent}
                tone={percent !== null && percent >= 90 ? "warning" : "accent"}
            />
            {description && (
                <p className="text-xs wrap-anywhere text-primary-400">{description}</p>
            )}
        </div>
    );
}
