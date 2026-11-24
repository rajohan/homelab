import type {
    AvailabilityKind,
    AvailabilityPeriod,
} from "@homelab/contracts/infrastructure";
import { ErrorNotice, LoadingState, SummaryStrip } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";

const titles: Record<AvailabilityPeriod, string> = {
    day: "Past 24 hours",
    week: "Past week",
    month: "Past 30 days",
    year: "Past year",
    all: "All time",
};
const percent = new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 2,
});

function ratio(value: number, total: number) {
    if (value > 0 && value / total < 0.0001) return "<" + percent.format(0.0001);
    if (value < total && value / total > 0.9999) return ">" + percent.format(0.9999);
    return percent.format(value / total);
}

/** Show measured availability and data coverage separately for one selected resource.
 * @returns All five comparison windows from the same observed conditions.
 */
export function AvailabilityReadings({
    kind,
    id,
}: {
    readonly kind: AvailabilityKind;
    readonly id: string;
}) {
    const query = useQuery({
        queryKey: ["operations", "infrastructure", "availability", kind, id],
        queryFn: ({ signal }) =>
            api.infrastructure.availability.query({ kind, id }, { signal }),
        staleTime: 300_000,
        refetchInterval: 300_000,
        retry: false,
    });
    if (query.isError) return <ErrorNotice error={query.error} />;
    if (!query.data) return <LoadingState label="Loading availability history…" />;
    const history = query.data;
    return (
        <div className="space-y-3">
            <p className="text-sm font-medium text-primary-200">{history.measure}</p>
            <SummaryStrip
                label="Availability over observed samples"
                items={history.periods.map((row) => ({
                    label: titles[row.period],
                    value: row.observed ? ratio(row.available, row.observed) : "Unknown",
                    detail: row.expected
                        ? ratio(row.observed, row.expected) + " coverage"
                        : "No observations",
                }))}
            />
            {history.monitorUnavailable && (
                <p className="text-xs text-primary-400">
                    Monitoring unavailable. Showing archived data.
                </p>
            )}
        </div>
    );
}
