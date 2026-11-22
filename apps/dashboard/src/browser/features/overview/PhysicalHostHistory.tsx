import type { InfrastructureHost } from "@homelab/contracts/infrastructure";
import { ErrorNotice, LoadingState, Select, TimeSeriesChart } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { hostHistoryOptions } from "../infrastructure/hostHistoryOptions";

/** Plot six hours of observed compute activity for one physical host at a time.
 * @returns A bounded historical chart with an explicit host selector and source state.
 */
export function PhysicalHostHistory({
    hosts,
}: {
    readonly hosts: readonly InfrastructureHost[];
}) {
    const [choice, setChoice] = useState("");
    const host = hosts.find((item) => item.id === choice) ?? hosts[0];
    const history = useQuery({
        ...hostHistoryOptions(host?.id ?? "", "6h", null, null),
        enabled: Boolean(host),
    });
    if (!host) return null;
    return (
        <section
            aria-label="CPU history"
            className="mt-4 grid min-w-0 grid-rows-[auto_minmax(11rem,1fr)] gap-2 border-t border-primary-700 pt-4 @min-[53rem]/overview:mt-0 @min-[53rem]/overview:ml-3 @min-[53rem]/overview:border-t-0 @min-[53rem]/overview:border-l @min-[53rem]/overview:pt-0 @min-[53rem]/overview:pl-3"
        >
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <h3 className="text-base font-semibold tracking-tight">
                        CPU history
                    </h3>
                    <p className="mt-0.5 text-xs text-primary-400">Last 6 hours</p>
                </div>
                <div className="w-36 max-w-full">
                    <Select
                        label="Chart host"
                        value={host.id}
                        options={hosts.map((item) => ({
                            value: item.id,
                            label: item.name,
                        }))}
                        onChange={setChoice}
                    />
                </div>
            </div>
            {history.isPending && <LoadingState label="Loading CPU history…" />}
            {history.isError && <ErrorNotice error={history.error} />}
            {history.data && (
                <TimeSeriesChart
                    fill
                    compact
                    label={`${host.name} CPU over the last six hours`}
                    series={history.data.cpu}
                    unit="percent"
                />
            )}
        </section>
    );
}
