import type { BackupState } from "@homelab/contracts/backups";
import {
    buttonStyles,
    EmptyState,
    ErrorNotice,
    formatDateTime,
    GroupedDirectory,
    LoadingState,
    SectionPanel,
    SummaryStrip,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Archive } from "lucide-react";

import { ObservationBadge } from "../operations/ObservationBadge";
import { backupInventoryQuery } from "./backupInventoryQuery";
import { BackupStatus } from "./BackupStatus";

const statusLabels = {
    healthy: "Healthy",
    attention: "Needs attention",
    unknown: "Unknown",
} as const;

function category(state: BackupState, stale: boolean) {
    if (stale) return "unknown";
    return state === "failed" || state === "overdue" ? "attention" : state;
}

/**
 * Present backup and verification observations without granting archive or restore access.
 * @returns Independent freshness, status totals and tasks grouped by host.
 */
export function BackupsPanel({ compact = false }: { readonly compact?: boolean }) {
    const query = useQuery(backupInventoryQuery);
    const data = query.data;
    const stale = !data?.configured || query.isError || (data?.stale ?? true);
    const rows = data?.inventory?.backups ?? [];
    const items = (["healthy", "attention", "unknown"] as const).map((status) => {
        const count = rows.filter((row) => category(row.state, stale) === status).length;
        return {
            label: statusLabels[status],
            value: stale && (status !== "unknown" || rows.length === 0) ? "—" : count,
            tone: status === "healthy" ? ("positive" as const) : ("warning" as const),
        };
    });
    return (
        <SectionPanel
            title="Backup protection"
            description="Backup completion, verification and freshness."
            icon={Archive}
            badge={
                <ObservationBadge
                    configured={data?.configured ?? true}
                    available={Boolean(data?.inventory)}
                    stale={stale}
                />
            }
        >
            {query.isPending && <LoadingState label="Loading backup status…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {data && (
                <>
                    <SummaryStrip label="Backup job status" items={items} />
                    {!compact && (
                        <>
                            {rows.length > 0 ? (
                                <GroupedDirectory
                                    items={rows}
                                    group={(row) => row.host}
                                    getKey={(row) => row.id}
                                    name={(row) => row.task}
                                    detail={(row) => (
                                        <>
                                            Last success{" "}
                                            {row.lastSuccessAt
                                                ? formatDateTime(row.lastSuccessAt)
                                                : "not reported"}
                                            {row.lastFailureAt && (
                                                <span className="block">
                                                    Last failure{" "}
                                                    {formatDateTime(row.lastFailureAt)}
                                                </span>
                                            )}
                                        </>
                                    )}
                                    status={(row) => (
                                        <BackupStatus
                                            state={stale ? "unknown" : row.state}
                                        />
                                    )}
                                />
                            ) : (
                                <EmptyState
                                    icon={Archive}
                                    title="No backup observations available"
                                    description="Backup tasks appear after the first observation."
                                />
                            )}
                        </>
                    )}
                    {compact && (
                        <Link
                            to="/backups"
                            className={buttonStyles({
                                variant: "secondary",
                                className: "w-full",
                            })}
                        >
                            View backups
                        </Link>
                    )}
                </>
            )}
        </SectionPanel>
    );
}
