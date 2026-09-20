import {
    Card,
    DataTable,
    ErrorNotice,
    LoadingState,
    Select,
    SectionHeader,
    buttonStyles,
    formatDateTime,
    queryRefresh,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PackageCheck } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { MetricStat } from "../infrastructure/MetricStat";
import { ObservationBadge } from "../operations/ObservationBadge";
import { AutomaticUpdates } from "./AutomaticUpdates";
import { SoftwareUpdates } from "./SoftwareUpdates";

/**
 * Present update observations separately from confirmed manual and opt-in automatic installation.
 * @returns Source freshness, software versions and explicitly configured update policies.
 */
export function UpdatesPanel({ compact = false }: { readonly compact?: boolean }) {
    const [source, setSource] = useState("");
    const query = useQuery({
        queryKey: ["operations", "updates"],
        queryFn: ({ signal }) => api.updates.inventory.query(undefined, { signal }),
        ...queryRefresh("slow"),
        retry: false,
    });
    const sources = query.data ?? [];
    const selected =
        sources.find((item) => item.id === source)?.id ?? sources[0]?.id ?? "";
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Available updates"
                description="Installed versions, available updates and update policies."
                icon={PackageCheck}
                actions={
                    <ObservationBadge
                        configured={
                            query.data === undefined ||
                            query.isError ||
                            sources.length > 0
                        }
                        available={sources.some((item) => item.report)}
                        stale={query.isError || sources.some((item) => item.stale)}
                    />
                }
            />
            {query.isPending && <LoadingState label="Loading update inventory…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {query.data && (
                <>
                    <dl className="grid grid-cols-3 gap-3">
                        <MetricStat
                            label="Available"
                            value={
                                sources.length > 0 && !query.isError
                                    ? sources.reduce(
                                          (sum, item) =>
                                              sum +
                                              (item.stale
                                                  ? 0
                                                  : (item.report?.available ?? 0)),
                                          0
                                      )
                                    : "—"
                            }
                        />
                        <MetricStat
                            label="Security"
                            value={
                                sources.length > 0 && !query.isError
                                    ? sources.reduce(
                                          (sum, item) =>
                                              sum +
                                              (item.stale
                                                  ? 0
                                                  : (item.report?.security ?? 0)),
                                          0
                                      )
                                    : "—"
                            }
                        />
                        <MetricStat
                            label="Missing / stale sources"
                            value={
                                sources.length > 0 && !query.isError
                                    ? sources.filter((item) => item.stale || !item.report)
                                          .length
                                    : "—"
                            }
                        />
                    </dl>
                    {!compact && (
                        <>
                            {sources.length > 0 && (
                                <DataTable
                                    label="Update sources"
                                    compact
                                    rows={sources}
                                    getKey={(item) => item.id}
                                    columns={[
                                        {
                                            id: "source",
                                            label: "Source",
                                            mobile: "title",
                                            render: (item) => item.label,
                                        },
                                        {
                                            id: "coverage",
                                            label: "Checks",
                                            render: (item) =>
                                                item.report?.coveredKinds.join(" · ") ??
                                                "Not reported",
                                        },
                                        {
                                            id: "time",
                                            label: "Observed",
                                            render: (item) =>
                                                item.report
                                                    ? formatDateTime(
                                                          item.report.capturedAt
                                                      )
                                                    : "Not reported",
                                        },
                                        {
                                            id: "state",
                                            label: "Status",
                                            render: (item) => (
                                                <ObservationBadge
                                                    configured
                                                    available={Boolean(item.report)}
                                                    stale={query.isError || item.stale}
                                                />
                                            ),
                                        },
                                    ]}
                                />
                            )}
                            {sources.length > 0 ? (
                                <>
                                    <Select
                                        label="Software source"
                                        value={selected}
                                        onChange={setSource}
                                        options={sources.map((item) => ({
                                            value: item.id,
                                            label: item.label,
                                        }))}
                                    />
                                    <SoftwareUpdates source={selected} />
                                    <AutomaticUpdates source={selected} />
                                </>
                            ) : (
                                !query.isError && (
                                    <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                                        No update sources are configured.
                                    </p>
                                )
                            )}
                        </>
                    )}
                    {compact && (
                        <Link
                            to="/updates"
                            className={buttonStyles({
                                variant: "secondary",
                                className: "w-full",
                            })}
                        >
                            View updates
                        </Link>
                    )}
                </>
            )}
        </Card>
    );
}
