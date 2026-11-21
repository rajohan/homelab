import { type HistoryRange, historyRanges } from "@homelab/contracts/infrastructure";
import {
    DetailSection,
    ErrorNotice,
    LoadingState,
    queryRefresh,
    TimeRangeSelect,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { ChartNoAxesCombined } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { ResourceHistoryCharts } from "./ResourceHistoryCharts";

/**
 * Load bounded resource history only while the application's details are open.
 * @returns Range selection and periodically refreshed application charts.
 */
export function ApplicationHistory({
    id,
    anchor,
    name,
}: {
    readonly anchor: string;
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
        <DetailSection
            anchor={anchor}
            icon={ChartNoAxesCombined}
            title="Resource history"
            actions={
                <TimeRangeSelect
                    ranges={historyRanges}
                    value={range}
                    onChange={setRange}
                />
            }
        >
            {query.isPending && <LoadingState label="Loading application history…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {query.data && (
                <ResourceHistoryCharts
                    name={name}
                    history={query.data}
                    diskLabel="Block I/O"
                />
            )}
        </DetailSection>
    );
}
