import { compareTableValues } from "@homelab/contracts/tableSort";
import {
    Badge,
    buttonStyles,
    ErrorNotice,
    GroupedDirectory,
    LoadingState,
    SectionPanel,
    Select,
    SummaryStrip,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PackageCheck } from "lucide-react";
import { useRef, useState } from "react";

import { ObservationBadge } from "../operations/ObservationBadge";
import { AutomaticUpdates } from "./AutomaticUpdates";
import { RestartStatus } from "./RestartStatus";
import { SoftwareUpdates } from "./SoftwareUpdates";
import { UpdateBatchAction } from "./UpdateBatchAction";
import { updateInventoryQuery } from "./updateInventoryQuery";

/**
 * Present update observations separately from confirmed manual and opt-in automatic installation.
 * @returns Source freshness, software versions and explicitly configured update policies.
 */
export function UpdatesPanel({ compact = false }: { readonly compact?: boolean }) {
    const [selection, setSelection] = useState("");
    const softwareHeading = useRef<HTMLDivElement>(null);
    const query = useQuery(updateInventoryQuery);
    const sources = query.data ?? [];
    const currentReports = sources.flatMap((item) =>
        item.report && !item.stale ? [item.report] : []
    );
    const securityUpdates = currentReports.reduce(
        (sum, report) => sum + report.security,
        0
    );
    const missingSources = sources.filter((item) => item.stale || !item.report).length;
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
    const inspectSource = (item: (typeof sources)[number]) => {
        setSelection(JSON.stringify([item.id, "software"]));
        softwareHeading.current?.focus({
            preventScroll: true,
        });
        softwareHeading.current?.scrollIntoView({
            block: "start",
        });
    };
    const sourceAction = (item: (typeof sources)[number]) => (
        <UpdateBatchAction
            source={item.id}
            label={item.label}
            disabled={query.isError || item.stale || (item.report?.available ?? 0) === 0}
        />
    );
    return (
        <div className="grid min-w-0 gap-5">
            <SectionPanel
                title={compact ? "Available updates" : "Update sources"}
                description="Select a source to inspect its packages. OS package lists expire after 48 hours."
                icon={PackageCheck}
                badge={
                    query.data && (
                        <ObservationBadge
                            configured={
                                query.data === undefined ||
                                query.isError ||
                                sources.length > 0
                            }
                            available={sources.some((item) => item.report)}
                            stale={query.isError || sources.some((item) => item.stale)}
                        />
                    )
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
            >
                {query.isPending && <LoadingState label="Loading update inventory…" />}
                {query.isError && <ErrorNotice error={query.error} />}
                {query.data && (
                    <>
                        <SummaryStrip
                            label="Update inventory counts"
                            items={[
                                {
                                    label: "Available",
                                    value:
                                        currentReports.length > 0 && !query.isError
                                            ? currentReports.reduce(
                                                  (sum, report) => sum + report.available,
                                                  0
                                              )
                                            : "—",
                                },
                                {
                                    label: "Security",
                                    attention: !query.isError && securityUpdates > 0,
                                    value:
                                        currentReports.length > 0 && !query.isError
                                            ? securityUpdates
                                            : "—",
                                },
                                {
                                    label: "Missing / stale sources",
                                    attention: !query.isError && missingSources > 0,
                                    value:
                                        sources.length > 0 && !query.isError
                                            ? missingSources
                                            : "—",
                                },
                            ]}
                        />
                        {!compact && (
                            <>
                                {sources.length > 0 && (
                                    <>
                                        <GroupedDirectory
                                            ordered
                                            items={sources.toSorted((a, b) =>
                                                compareTableValues(
                                                    a.label,
                                                    b.label,
                                                    "ascending"
                                                )
                                            )}
                                            group={(item) => {
                                                if (
                                                    query.isError ||
                                                    item.stale ||
                                                    !item.report
                                                )
                                                    return "Status unavailable";
                                                if (item.report.security > 0)
                                                    return "Security updates";
                                                return item.report.available > 0
                                                    ? "Updates available"
                                                    : "Up to date";
                                            }}
                                            getKey={(item) => item.id}
                                            name={(item) => item.label}
                                            detail={(item) =>
                                                item.report?.coveredKinds.join(" · ") ||
                                                "Checks not reported"
                                            }
                                            status={(item) => (
                                                <span className="flex flex-wrap items-center justify-end gap-2">
                                                    {!query.isError &&
                                                        !item.stale &&
                                                        item.report && (
                                                            <span className="tabular-nums">
                                                                {item.report.available}{" "}
                                                                available
                                                            </span>
                                                        )}
                                                    {item.report &&
                                                        !item.stale &&
                                                        !query.isError &&
                                                        item.report.security > 0 && (
                                                            <Badge tone="warning">
                                                                {item.report.security}{" "}
                                                                security
                                                            </Badge>
                                                        )}
                                                    <RestartStatus
                                                        observation={item.restart}
                                                        unavailable={query.isError}
                                                    />
                                                </span>
                                            )}
                                            onSelect={inspectSource}
                                            actions={sourceAction}
                                        />
                                    </>
                                )}
                                {sources.length === 0 && !query.isError && (
                                    <p className="text-sm text-primary-400">
                                        No update sources are configured.
                                    </p>
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
            </SectionPanel>
            {!compact && (
                <div ref={softwareHeading} tabIndex={-1} className="min-w-0 scroll-mt-18">
                    <SectionPanel
                        icon={PackageCheck}
                        title="Software inventory"
                        actions={
                            selected && (
                                <Select
                                    label="Software source"
                                    compact
                                    icon={PackageCheck}
                                    value={selected?.value ?? ""}
                                    onChange={setSelection}
                                    options={options}
                                />
                            )
                        }
                    >
                        {selected?.category === "toolchains" && (
                            <p className="mt-1 text-sm text-primary-400">
                                Update shared runtimes separately. Version-pinned projects
                                keep their existing runtime.
                            </p>
                        )}
                        <SoftwareUpdates
                            source={selected?.source}
                            category={selected?.category ?? "software"}
                        />
                        {selected && (
                            <AutomaticUpdates
                                key={selected.value}
                                source={selected.source}
                                category={selected.category}
                            />
                        )}
                    </SectionPanel>
                </div>
            )}
        </div>
    );
}
