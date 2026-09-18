import {
    CartesianGrid,
    Legend,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import { formatDateTime, formatDateTimeParts } from "../../lib/formatDateTime";
import { formatMetric, type MetricUnit } from "../../lib/formatMetric";
import { chartData, type ChartSeries } from "./chartData";
import { chartValueAxis } from "./chartValueAxis";

const colors = ["var(--chart-accent)", "#34d399", "#c084fc", "#fbbf24"];

/**
 * Render shared accessible time-series charts with consistent units, tooltips and gap handling.
 * @returns A bounded responsive chart or an explicit no-data state.
 */
export function TimeSeriesChart({
    label,
    series,
    unit,
    capacityKey,
}: {
    readonly label: string;
    readonly series: readonly ChartSeries[];
    readonly unit: MetricUnit;
    readonly capacityKey?: string | undefined;
}) {
    const data = chartData(series);
    const valueAxis = chartValueAxis(series, capacityKey);
    const firstTime = data[0]?.time ?? 0;
    const lastTime = data.at(-1)?.time ?? 0;
    const showDates = lastTime - firstTime >= 86_400_000;
    if (!series.some((entry) => entry.points.some((point) => point.value !== null)))
        return (
            <p className="flex h-56 items-center justify-center rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                No measurements for this time range.
            </p>
        );
    return (
        <figure aria-label={label} className="h-64 min-w-0 text-xs time-series-chart">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} debounce={50}>
                <LineChart
                    data={data}
                    margin={{ top: 12, right: 12, bottom: 0, left: 4 }}
                    accessibilityLayer
                >
                    <CartesianGrid stroke="var(--chart-border)" vertical={false} />
                    <XAxis
                        dataKey="time"
                        type="number"
                        domain={["dataMin", "dataMax"]}
                        tickFormatter={(value: number) =>
                            formatDateTimeParts(value)[showDates ? 0 : 1]
                        }
                        minTickGap={48}
                        stroke="var(--chart-text)"
                        tick={{ fill: "var(--chart-text)" }}
                        tickLine={false}
                    />
                    <YAxis
                        width={unit === "bytes/s" ? 96 : 76}
                        tickFormatter={(value: number) => formatMetric(value, unit)}
                        domain={valueAxis.domain}
                        {...(valueAxis.ticks ? { ticks: valueAxis.ticks } : {})}
                        stroke="var(--chart-text)"
                        tick={{ fill: "var(--chart-text)" }}
                        tickLine={false}
                        axisLine={false}
                    />
                    <Tooltip
                        contentStyle={{
                            background: "var(--chart-surface)",
                            borderColor: "var(--chart-border)",
                            borderRadius: 8,
                        }}
                        labelFormatter={(value) => formatDateTime(Number(value))}
                        formatter={(value) =>
                            formatMetric(typeof value === "number" ? value : null, unit)
                        }
                    />
                    <Legend />
                    {series.map((entry, index) => (
                        <Line
                            key={entry.key}
                            dataKey={entry.key}
                            name={entry.label}
                            type="linear"
                            stroke={colors[index % colors.length] ?? "#60a5fa"}
                            strokeWidth={2}
                            dot={false}
                            isAnimationActive={false}
                            connectNulls={false}
                        />
                    ))}
                </LineChart>
            </ResponsiveContainer>
        </figure>
    );
}
