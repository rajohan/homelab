import {
    Area,
    CartesianGrid,
    ComposedChart,
    Legend,
    Line,
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
    compact = false,
    fill = false,
    capacityKey,
}: {
    readonly fill?: boolean;
    readonly compact?: boolean;
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
            <p className="flex h-56 items-center justify-center rounded-lg border border-primary-700 bg-surface-empty p-4 text-sm text-primary-400">
                No measurements for this time range.
            </p>
        );
    const height = compact ? "h-48" : "h-64";
    return (
        <figure
            aria-label={label}
            className={`relative min-w-0 text-xs time-series-chart ${fill ? "min-h-44 self-stretch" : height}`}
        >
            <div className="absolute inset-0">
                <ResponsiveContainer
                    width="100%"
                    height="100%"
                    minWidth={0}
                    debounce={50}
                >
                    <ComposedChart
                        data={data}
                        margin={{ top: 8, right: 6, bottom: 0, left: 0 }}
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
                            minTickGap={32}
                            height={24}
                            stroke="var(--chart-text)"
                            tick={{ fill: "var(--chart-text)" }}
                            tickLine={false}
                        />
                        <YAxis
                            width="auto"
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
                                formatMetric(
                                    typeof value === "number" ? value : null,
                                    unit
                                )
                            }
                        />
                        {(!compact || series.length > 1) && <Legend />}
                        {compact && series.length === 1 && series[0] ? (
                            <Area
                                type="linear"
                                dataKey={series[0].key}
                                name={series[0].label}
                                stroke="var(--chart-accent)"
                                fill="var(--chart-accent)"
                                fillOpacity={0.15}
                                strokeWidth={2}
                                dot={false}
                                isAnimationActive={false}
                                connectNulls={false}
                            />
                        ) : (
                            series.map((entry, index) => (
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
                            ))
                        )}
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
        </figure>
    );
}
