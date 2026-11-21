import type { ReactNode } from "react";

import { cn } from "../../lib/classNames";
import { formatMetric, utilization } from "../../lib/formatMetric";
import { MetricStat } from "../SectionHeader/MetricStat";
import { CapacityReading } from "./CapacityReading";

/** Show measured CPU, memory and disk usage alongside the runtime facts available for this resource.
 * @returns Aligned capacity readings and responsive runtime statistics.
 */
export function ResourceReadings({
    name,
    cpu,
    cores,
    perCore = false,
    memory,
    capacity,
    disk,
    runtime,
    cpuNote,
}: {
    readonly name: string;
    readonly cpu: number | null;
    readonly cores: number | null;
    readonly perCore?: boolean;
    readonly memory: number | null;
    readonly capacity: number | null;
    readonly disk?: { used: number | null; size: number | null };
    readonly runtime?:
        | readonly { label: string; value: string; detail?: string }[]
        | undefined;
    readonly cpuNote?: ReactNode;
}) {
    const count = cores !== null && cores > 0 ? cores : null;
    const coreLabel = count === 1 ? "1 core" : `${count} cores`;
    let cpuCapacity = count === null ? "Cores unknown" : coreLabel;
    let cpuUtilization = cpu;
    if (perCore) {
        const maximum = count === null ? null : 100 * count;
        cpuUtilization = utilization(cpu, maximum);
        cpuCapacity =
            maximum === null
                ? "100% per core"
                : `of ${formatMetric(maximum, "percent")} · ${coreLabel}`;
    }
    const cpuDetail = (
        <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="whitespace-nowrap">{cpuCapacity}</span>
            {cpuNote}
        </span>
    );
    return (
        <div className="@container/readings">
            <div
                className={cn(
                    "grid min-w-0 gap-x-5 gap-y-3",
                    runtime &&
                        (disk
                            ? "@min-[44rem]/readings:grid-cols-[minmax(0,5fr)_minmax(7rem,1fr)]"
                            : "@min-[44rem]/readings:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]")
                )}
            >
                <div className="min-w-0">
                    <dl
                        aria-label={`${name} resource readings`}
                        className={cn(
                            "grid gap-x-3 gap-y-1 @min-[24rem]/readings:gap-x-5",
                            disk ? "grid-cols-3" : "grid-cols-2",
                            cpuNote &&
                                "@min-[44rem]/readings:grid-cols-[minmax(0,1.65fr)_repeat(2,minmax(0,1fr))]"
                        )}
                    >
                        <CapacityReading
                            label="CPU"
                            value={formatMetric(cpu, "percent")}
                            percent={cpuUtilization}
                            tone="cpu"
                            capacity={
                                cpuNote ? (
                                    <span className="hidden @min-[44rem]/readings:inline">
                                        {cpuDetail}
                                    </span>
                                ) : (
                                    cpuCapacity
                                )
                            }
                        />
                        <CapacityReading
                            label="Memory"
                            value={formatMetric(memory, "bytes")}
                            capacity={`of ${formatMetric(capacity, "bytes")}`}
                            percent={utilization(memory, capacity)}
                            tone="memory"
                        />
                        {disk && (
                            <CapacityReading
                                label="System disk (/)"
                                value={formatMetric(disk.used, "bytes")}
                                capacity={`of ${formatMetric(disk.size, "bytes")}`}
                                percent={utilization(disk.used, disk.size)}
                                tone="storage"
                            />
                        )}
                    </dl>
                    {cpuNote && (
                        <p className="mt-2 text-xs text-primary-400 tabular-nums @min-[44rem]/readings:hidden">
                            {cpuDetail}
                        </p>
                    )}
                </div>
                {runtime && (
                    <dl
                        aria-label={`${name} runtime`}
                        className={cn(
                            "grid min-w-0 content-start gap-x-3 border-t border-primary-700 pt-3 @min-[44rem]/readings:border-t-0 @min-[44rem]/readings:border-l @min-[44rem]/readings:pt-0 @min-[44rem]/readings:pl-5",
                            runtime.length > 1 &&
                                "grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1fr)]"
                        )}
                    >
                        {runtime.map((item) => (
                            <MetricStat
                                key={item.label}
                                {...item}
                                appearance="reading"
                                className="row-span-3 grid grid-rows-subgrid"
                            />
                        ))}
                    </dl>
                )}
            </div>
        </div>
    );
}
