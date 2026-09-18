import type { InfrastructureHistory } from "@homelab/contracts/infrastructure";
import { TimeSeriesChart } from "@homelab/ui";

/**
 * Render the same resource chart layout for hosts and applications.
 * @returns Accessible, responsive charts with consistent units and missing-data presentation.
 */
export function ResourceHistoryCharts({
    name,
    history,
    networkLabel = "Network",
    diskLabel = "Disk I/O",
}: {
    readonly name: string;
    readonly history: InfrastructureHistory;
    readonly networkLabel?: string;
    readonly diskLabel?: string;
}) {
    return (
        <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
                {(
                    [
                        { key: "cpu", label: "CPU usage", unit: "percent" },
                        { key: "memory", label: "Memory usage", unit: "bytes" },
                        { key: "network", label: networkLabel, unit: "bytes/s" },
                        { key: "disk", label: diskLabel, unit: "bytes/s" },
                    ] as const
                ).map((chart) => (
                    <section
                        key={chart.key}
                        className="min-w-0 rounded-lg border border-primary-700 bg-primary-950/40 p-3"
                    >
                        <h3 className="mb-2 text-sm font-semibold">{chart.label}</h3>
                        <TimeSeriesChart
                            label={`${name}: ${chart.label}`}
                            series={history[chart.key]}
                            unit={chart.unit}
                            capacityKey={
                                chart.key === "memory" ? "memoryCapacity" : undefined
                            }
                        />
                    </section>
                ))}
            </div>
        </div>
    );
}
