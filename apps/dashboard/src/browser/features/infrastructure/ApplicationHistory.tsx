import { historyRanges, type HistoryRange } from "@homelab/contracts/infrastructure";
import { ErrorNotice, LoadingState, Select, queryRefresh } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import { ResourceHistoryCharts } from "./ResourceHistoryCharts";

/**
 * Load bounded resource history only while the application's details are open.
 * @returns Range selection and periodically refreshed application charts.
 */
export function ApplicationHistory({
    id,
    name,
}: {
    readonly id: string;
    readonly name: string;
}) {
    const [range, setRange] = useState<HistoryRange>("6h");
    const query = useQuery({
        queryKey: ["operations", "infrastructure", "applicationHistory", id, range],
        queryFn: ({ signal }) =>
            api.infrastructure.applicationHistory.query({ id, range }, { signal }),
        staleTime: 60_000,
        ...queryRefresh("history"),
        retry: false,
    });
    return (
        <div className="space-y-4">
            <Select
                label="Time range"
                value={range}
                onChange={setRange}
                options={historyRanges.map((value) => ({
                    value,
                    label: `Last ${value}`,
                }))}
            />
            {query.isPending && <LoadingState label="Loading application history…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {query.data && (
                <ResourceHistoryCharts
                    name={name}
                    history={query.data}
                    diskLabel="Block I/O"
                />
            )}
        </div>
    );
}
