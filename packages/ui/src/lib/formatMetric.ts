export type MetricUnit =
    | "bytes"
    | "bytes/s"
    | "percent"
    | "number"
    | "seconds"
    | "celsius"
    | "bits/s";
const numberFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });

/**
 * Format monitoring values consistently without displaying unknown data as zero.
 * @param value - A finite value in base units, or null when unavailable.
 * @param unit - The measurement's explicit unit.
 * @returns A compact, human-readable measurement with an unambiguous unit.
 */
export function formatMetric(
    value: number | null | undefined,
    unit: MetricUnit = "number"
): string {
    if (value === null || value === undefined || !Number.isFinite(value))
        return "Not reported";
    if (unit === "percent") return `${numberFormat.format(value)}%`;
    if (unit === "celsius") return `${numberFormat.format(value)} °C`;
    if (unit === "seconds") {
        if (value >= 86_400)
            return `${Math.floor(value / 86_400)}d ${Math.floor((value % 86_400) / 3600)}h`;
        if (value >= 3600)
            return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
        return `${Math.floor(value / 60)}m`;
    }
    if (unit === "bytes" || unit === "bytes/s" || unit === "bits/s") {
        const divisor = unit === "bits/s" ? 1000 : 1024;
        const units =
            unit === "bits/s"
                ? ["bit", "kbit", "Mbit", "Gbit", "Tbit"]
                : ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
        const exponent =
            value > 0
                ? Math.min(
                      Math.floor(Math.log(value) / Math.log(divisor)),
                      units.length - 1
                  )
                : 0;
        const index = Math.max(0, exponent);
        return `${numberFormat.format(value / divisor ** index)} ${units[index]}${unit.endsWith("/s") ? "/s" : ""}`;
    }
    return numberFormat.format(value);
}

/**
 * Calculate utilization only when both measurements and a positive capacity exist.
 * @param used - Used base units, with zero retained as a valid measurement.
 * @param total - Total capacity in the same units.
 * @returns Utilization percentage or null when capacity is unknown.
 */
export function utilization(used: number | null, total: number | null): number | null {
    return used !== null && total !== null && total > 0 ? (used / total) * 100 : null;
}
