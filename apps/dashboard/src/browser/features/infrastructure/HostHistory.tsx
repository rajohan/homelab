import {
    historyRanges,
    type HistoryRange,
    type InfrastructureHost,
    type InfrastructureInventory,
} from "@homelab/contracts/infrastructure";
import { ErrorNotice, LoadingState, Select, queryRefresh } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import { ResourceHistoryCharts } from "./ResourceHistoryCharts";

/**
 * Fetch only the selected host's historical series, using bounded server-owned queries.
 * @returns Four responsive charts with explicit device and time-range selection.
 */
export function HostHistory({
    host,
    inventory,
}: {
    readonly host: InfrastructureHost;
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
    const query = useQuery({
        queryKey: [
            "operations",
            "infrastructure",
            "history",
            host.id,
            range,
            network,
            disk,
        ],
        queryFn: ({ signal }) =>
            api.infrastructure.history.query(
                { id: host.id, range, network, disk },
                { signal }
            ),
        staleTime: 60_000,
        ...queryRefresh("history"),
        retry: false,
    });
    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
                <Select
                    label="Time range"
                    value={range}
                    onChange={setRange}
                    options={historyRanges.map((value) => ({
                        value,
                        label: `Last ${value}`,
                    }))}
                />
                {networks.length > 0 && (
                    <Select
                        label="Network interface"
                        value={network ?? ""}
                        onChange={setNetwork}
                        options={networks.map((row) => ({
                            value: row.device,
                            label: `${row.device}${row.virtual ? " (virtual)" : ""}`,
                        }))}
                    />
                )}
                {disks.length > 0 && (
                    <Select
                        label="Block device"
                        value={disk ?? ""}
                        onChange={setDisk}
                        options={disks.map((row) => ({
                            value: row.device,
                            label: row.device,
                        }))}
                    />
                )}
            </div>
            {!host.guestMetricsAvailable && (
                <p className="text-sm text-primary-400">
                    Hypervisor measurements. Memory includes guest caches and is not the
                    available-memory estimate inside the guest. Network and disk I/O cover
                    the virtual machine, not individual devices.
                </p>
            )}
            {query.isPending && <LoadingState label="Loading resource history…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {query.data && (
                <ResourceHistoryCharts
                    name={host.name}
                    history={query.data}
                    networkLabel={`Network${network ? ` · ${network}` : ""}`}
                    diskLabel={`Disk I/O${disk ? ` · ${disk}` : ""}`}
                />
            )}
        </div>
    );
}
