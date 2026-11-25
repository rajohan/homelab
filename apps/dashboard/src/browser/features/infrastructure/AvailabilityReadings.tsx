import type { AvailabilityKind } from "@homelab/contracts/infrastructure";
import { AvailabilityTimeline, ErrorNotice, LoadingState } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";

/** Display the shared uptime timeline for the selected resource.
 * @returns Period controls, current status and the measured availability history.
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
            <AvailabilityTimeline key={kind + ":" + id} history={history} />
            {history.monitorUnavailable && (
                <p className="text-xs text-primary-400">
                    Monitoring unavailable. Showing archived data.
                </p>
            )}
        </div>
    );
}
