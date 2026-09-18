import type { ChartSeries } from "./chartData";

/**
 * Fit a capacity chart to its measured ceiling instead of rounding up to a nice scale.
 * @param series - The displayed measurements for the selected historical window.
 * @param capacityKey - Optional series identifying the measured capacity.
 * @returns Exact bounds and evenly spaced ticks, or automatic scaling without capacity.
 */
export function chartValueAxis(
    series: readonly ChartSeries[],
    capacityKey?: string
): {
    domain: [number, number | "auto"];
    ticks: number[] | undefined;
} {
    const capacity = series.find((entry) => entry.key === capacityKey);
    if (!capacity?.points.some((point) => point.value !== null && point.value > 0))
        return { domain: [0, "auto"], ticks: undefined };
    let maximum = 0;
    for (const entry of series)
        for (const point of entry.points)
            if (point.value !== null && Number.isFinite(point.value))
                maximum = Math.max(maximum, point.value);
    // Preserve real values above a capacity, e.g. a limit lowered during the window.
    return {
        domain: [0, maximum],
        ticks: Array.from({ length: 5 }, (_, index) => (maximum * index) / 4),
    };
}
