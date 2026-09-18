export interface ChartSeries {
    readonly key: string;
    readonly label: string;
    readonly points: readonly { readonly time: number; readonly value: number | null }[];
}

/**
 * Align independent series by timestamp, retaining null gaps between samples.
 * @param series - Bounded, already downsampled historical measurements.
 * @returns Ordered rows consumed by chart renderers.
 */
export function chartData(series: readonly ChartSeries[]) {
    const rows = new Map<number, Record<string, number | null>>();
    for (const entry of series)
        for (const point of entry.points) {
            const row: Record<string, number | null> =
                rows.get(point.time) ??
                Object.fromEntries<number | null>([
                    ["time", point.time],
                    ...series.map((item): [string, null] => [item.key, null]),
                ]);
            row[entry.key] = point.value;
            rows.set(point.time, row);
        }
    return [...rows.entries()]
        .toSorted(([left], [right]) => left - right)
        .map(([, row]) => row);
}
