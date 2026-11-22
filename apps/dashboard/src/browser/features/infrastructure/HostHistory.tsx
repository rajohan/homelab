import {
    type HistoryRange,
    historyRanges,
    type InfrastructureHost,
    type InfrastructureInventory,
} from "@homelab/contracts/infrastructure";
import {
    DetailSection,
    ErrorNotice,
    LoadingState,
    Select,
    TimeRangeSelect,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { ChartNoAxesCombined, HardDrive, Network } from "lucide-react";
import { useState } from "react";

import { hostChartReadings } from "./hostChartReadings";
import { hostHistoryOptions } from "./hostHistoryOptions";
import { ResourceHistoryCharts } from "./ResourceHistoryCharts";

/**
 * Fetch only the selected host's historical series, using bounded server-owned queries.
 * @returns Four responsive charts with explicit device and time-range selection.
 */
export function HostHistory({
    host,
    inventory,
    anchor,
}: {
    readonly host: InfrastructureHost;
    readonly anchor: string;
    readonly inventory: InfrastructureInventory;
}) {
    const networks = inventory.networks
        .filter((row) => row.host === host.host)
        .toSorted(
            (left, right) =>
                Number(left.virtual) - Number(right.virtual) ||
                Number(right.up) - Number(left.up) ||
                left.device.localeCompare(right.device)
        );
    const disks = inventory.disks.filter((row) => row.host === host.host);
    const [range, setRange] = useState<HistoryRange>("6h");
    const [networkChoice, setNetwork] = useState(networks[0]?.device ?? "");
    const [diskChoice, setDisk] = useState(disks[0]?.device ?? "");
    const network = networks.some((item) => item.device === networkChoice)
        ? networkChoice
        : (networks[0]?.device ?? null);
    const disk = disks.some((item) => item.device === diskChoice)
        ? diskChoice
        : (disks[0]?.device ?? null);
    const query = useQuery(hostHistoryOptions(host.id, range, network, disk));
    return (
        <DetailSection
            icon={ChartNoAxesCombined}
            title="Resource history"
            anchor={anchor}
            actions={
                <fieldset
                    className="flex max-w-full min-w-0 flex-wrap items-center gap-2"
                    aria-label="History filters"
                >
                    <TimeRangeSelect
                        ranges={historyRanges}
                        value={range}
                        onChange={setRange}
                    />
                    {networks.length > 1 && (
                        <Select
                            compact
                            icon={Network}
                            label="Network interface"
                            value={network ?? ""}
                            onChange={setNetwork}
                            options={networks.map((row) => ({
                                value: row.device,
                                label: `${row.device}${row.virtual ? " (virtual)" : ""}`,
                            }))}
                        />
                    )}
                    {disks.length > 1 && (
                        <Select
                            compact
                            icon={HardDrive}
                            label="Block device"
                            value={disk ?? ""}
                            onChange={setDisk}
                            options={disks.map((row) => ({
                                value: row.device,
                                label: row.device,
                            }))}
                        />
                    )}
                </fieldset>
            }
        >
            {!(host.guestMetricsConfigured ?? host.guestMetricsAvailable) &&
                networks.length === 0 &&
                disks.length === 0 && (
                    <p className="text-sm text-primary-400">
                        Hypervisor measurements. Memory includes guest caches and is not
                        the available-memory estimate inside the guest. Network and disk
                        I/O cover the virtual machine, not individual devices.
                    </p>
                )}
            {query.isPending && <LoadingState label="Loading resource history…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            <ResourceHistoryCharts
                readings={hostChartReadings(host)}
                name={host.name}
                history={query.data}
                networkLabel={`Network${network ? ` · ${network}` : ""}`}
                diskLabel={`Disk I/O${disk ? ` · ${disk}` : ""}`}
            />
        </DetailSection>
    );
}
