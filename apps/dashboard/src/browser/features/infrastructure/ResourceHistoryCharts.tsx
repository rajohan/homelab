import type { InfrastructureHistory } from "@homelab/contracts/infrastructure";
import { DetailFacts, TimeSeriesChart } from "@homelab/ui";

/**
 * Render the same resource chart layout for hosts and applications.
 * @returns Accessible, responsive charts with consistent units and missing-data presentation.
 */
export function ResourceHistoryCharts({
    name,
    history,
    readings,
    networkLabel = "Network",
    diskLabel = "Disk I/O",
}: {
    readonly name: string;
    readonly history: InfrastructureHistory | undefined;
    readonly readings?: Partial<
        Record<
            keyof Omit<InfrastructureHistory, "capturedAt">,
            { label?: string; items: readonly { label: string; value: string }[] }
        >
    >;

    readonly networkLabel?: string;
    readonly diskLabel?: string;
}) {
    return (
        <div className="@container/history">
            <div className="grid gap-x-6 gap-y-4 @min-[38rem]/history:grid-cols-2">
                {(
                    [
                        { key: "cpu", label: "CPU usage", unit: "percent" },
                        { key: "memory", label: "Memory usage", unit: "bytes" },
                        { key: "network", label: networkLabel, unit: "bytes/s" },
                        { key: "disk", label: diskLabel, unit: "bytes/s" },
                    ] as const
                ).map((chart) => {
                    const extra = readings?.[chart.key];
                    if (!history && (extra?.items.length ?? 0) === 0) return null;
                    return (
                        <section
                            key={chart.key}
                            className="min-w-0 border-b border-primary-700/70 pb-3"
                        >
                            <h3 className="mb-2 text-sm font-semibold">{chart.label}</h3>
                            {history && (
                                <TimeSeriesChart
                                    label={`${name}: ${chart.label}`}
                                    compact
                                    series={history[chart.key]}
                                    unit={chart.unit}
                                    capacityKey={
                                        chart.key === "memory"
                                            ? "memoryCapacity"
                                            : undefined
                                    }
                                />
                            )}
                            {extra && extra.items.length > 0 && (
                                <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                                    {extra.label && (
                                        <span className="text-primary-400">
                                            {extra.label}
                                        </span>
                                    )}
                                    <DetailFacts inline items={extra.items} />
                                </div>
                            )}
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
