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
import { RestartStatus } from "./RestartStatus";
import { SoftwareUpdates } from "./SoftwareUpdates";
import { UpdateBatchAction } from "./UpdateBatchAction";

/**
 * Present update observations separately from confirmed manual and opt-in automatic installation.
 * @returns Source freshness, software versions and explicitly configured update policies.
 */
export function UpdatesPanel({ compact = false }: { readonly compact?: boolean }) {
    const [selection, setSelection] = useState("");
    const query = useQuery({
        queryKey: ["operations", "updates"],
        queryFn: ({ signal }) => api.updates.inventory.query(undefined, { signal }),
        ...queryRefresh("normal"),
        retry: false,
    });
    const sources = query.data ?? [];
    const options = sources.flatMap((item) => {
        const categories = item.report?.coveredKinds.includes("runtime")
            ? (["software", "toolchains"] as const)
            : (["software"] as const);
        return categories.map((category) => ({
            value: JSON.stringify([item.id, category]),
            label: category === "toolchains" ? `${item.label} · Toolchains` : item.label,
            source: item.id,
            category,
        }));
    });
    const selected = options.find((item) => item.value === selection) ?? options[0];
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Available updates"
                description="Installed versions, available updates and update policies. Inventory observation and package-list refresh times are separate; OS package lists older than 48 hours are stale."
                icon={PackageCheck}
                badge={
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
                actions={
                    !compact && (
                        <UpdateBatchAction
                            disabled={
                                query.isError ||
                                !sources.some(
                                    (item) =>
                                        !item.stale && (item.report?.available ?? 0) > 0
                                )
                            }
                            className="min-[30rem]:w-auto"
                        />
                    )
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
                                    className="@max-[48rem]:[&_tr[data-index]]:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]"
                                    rows={sources}
                                    getKey={(item) => item.id}
                                    columns={[
                                        {
                                            id: "source",
                                            sortValue: (row) => row.label,
                                            label: "Source",
                                            mobile: "title",
                                            render: (item) => item.label,
                                        },
                                        {
                                            id: "updates",
                                            sortValue: (row) => row.report?.available,
                                            label: "Updates",
                                            render: (item) =>
                                                !query.isError &&
                                                !item.stale &&
                                                item.report
                                                    ? item.report.available
                                                    : "—",
                                        },
                                        {
                                            id: "coverage",
                                            sortValue: (row) =>
                                                row.report?.coveredKinds.join(" "),
                                            label: "Checks",
                                            render: (item) =>
                                                item.report?.coveredKinds.join(" · ") ??
                                                "Not reported",
                                        },
                                        {
                                            id: "time",
                                            sortValue: (row) => row.report?.capturedAt,
                                            label: "Inventory observed",
                                            render: (item) =>
                                                item.report
                                                    ? formatDateTime(
                                                          item.report.capturedAt
                                                      )
                                                    : "Not reported",
                                        },
                                        {
                                            id: "packageLists",
                                            sortValue: (row) =>
                                                row.report?.repositoryMetadataAt,
                                            label: "Package lists refreshed",
                                            render: (item) => {
                                                if (
                                                    !item.report?.coveredKinds.includes(
                                                        "os"
                                                    )
                                                )
                                                    return "Not applicable";
                                                return item.report.repositoryMetadataAt
                                                    ? formatDateTime(
                                                          item.report.repositoryMetadataAt
                                                      )
                                                    : "Not reported";
                                            },
                                        },
                                        {
                                            id: "state",
                                            sortValue: (row) => row.stale,
                                            label: "Status",
                                            render: (item) => (
                                                <div className="flex flex-wrap items-center gap-1.5">
                                                    <ObservationBadge
                                                        configured
                                                        available={Boolean(item.report)}
                                                        stale={
                                                            query.isError || item.stale
                                                        }
                                                    />
                                                    <span className="@min-[48rem]:hidden">
                                                        <RestartStatus
                                                            observation={item.restart}
                                                            unavailable={query.isError}
                                                        />
                                                    </span>
                                                </div>
                                            ),
                                        },
                                        {
                                            id: "restart",
                                            label: "Restart",
                                            mobile: "hidden",
                                            sortValue: (item) =>
                                                item.restart?.stale
                                                    ? null
                                                    : item.restart?.required,
                                            render: (item) => (
                                                <RestartStatus
                                                    observation={item.restart}
                                                    unavailable={query.isError}
                                                />
                                            ),
                                        },
                                        {
                                            id: "actions",
                                            label: "Actions",
                                            width: "w-40",
                                            mobile: "footer-actions",
                                            render: (item) => (
                                                <UpdateBatchAction
                                                    source={item.id}
                                                    label={item.label}
                                                    disabled={
                                                        query.isError ||
                                                        item.stale ||
                                                        (item.report?.available ?? 0) ===
                                                            0
                                                    }
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
                                        value={selected?.value ?? ""}
                                        onChange={setSelection}
                                        options={options}
                                    />
                                    {selected && (
                                        <div key={selected.value} className="space-y-4">
                                            {selected.category === "toolchains" && (
                                                <p className="mt-1 text-sm text-primary-400">
                                                    Update shared runtimes separately.
                                                    Version-pinned projects keep their
                                                    existing runtime.
                                                </p>
                                            )}
                                            <SoftwareUpdates
                                                source={selected.source}
                                                category={selected.category}
                                            />
                                            <AutomaticUpdates
                                                source={selected.source}
                                                category={selected.category}
                                            />
                                        </div>
                                    )}
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
