import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { incidentOptions } from "../alerts/incidentQueries";
import { backupInventoryQuery } from "../backups/backupInventoryQuery";
import { useInfrastructure } from "../infrastructure/useInfrastructure";
import { workerOverviewQuery } from "../jobs/workerOverviewQuery";
import { updateInventoryQuery } from "../updates/updateInventoryQuery";

/** Read the same observations as the domain pages; only current samples contribute to live totals.
 * @returns Independent query states, current measurements and domain summaries.
 */
export function useOverviewReadings() {
    const infra = useInfrastructure();
    const incidents = useInfiniteQuery(incidentOptions("current"));
    const backups = useQuery(backupInventoryQuery);
    const updates = useQuery(updateInventoryQuery);
    const worker = useQuery(workerOverviewQuery);
    const page = incidents.data?.pages[0];
    const alerts =
        page?.configured && page.capturedAt && !page.stale && !incidents.isError
            ? page
            : undefined;
    const protection =
        backups.data?.configured && !backups.data.stale && !backups.isError
            ? backups.data.inventory
            : undefined;
    const backupRows = protection?.backups ?? [];
    const sources = updates.isError ? undefined : updates.data;
    const reports =
        sources?.flatMap((source) =>
            !source.stale && source.report ? [source.report] : []
        ) ?? [];
    const queue = worker.isError ? undefined : worker.data;
    const inventory = infra.stale ? undefined : infra.inventory;
    const hosts = inventory?.hosts ?? [],
        apps = inventory?.applications ?? [],
        probes = inventory?.services.filter((s) => s.kind === "probe") ?? [];
    const issueBackups = backupRows.filter(
        (row) => row.state === "failed" || row.state === "overdue"
    );
    const missingSources = sources?.filter((s) => s.stale || !s.report).length;
    const active = alerts?.counts.find((row) => row.state === "active")?.count ?? 0;
    const pending =
        infra.query.isPending ||
        incidents.isPending ||
        backups.isPending ||
        updates.isPending ||
        worker.isPending;
    const available = reports.reduce((sum, r) => sum + r.available, 0),
        security = reports.reduce((sum, r) => sum + r.security, 0);
    const jobCount = (state: string) =>
        queue?.counts.find((row) => row.state === state)?.count ?? 0;
    return {
        infra,
        incidents,
        backups,
        updates,
        worker,
        page,
        alerts,
        protection,
        backupRows,
        sources,
        reports,
        queue,
        inventory,
        hosts,
        apps,
        probes,
        issueBackups,
        missingSources,
        active,
        pending,
        available,
        security,
        jobCount,
    };
}
export type OverviewReadings = ReturnType<typeof useOverviewReadings>;
