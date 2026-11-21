import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";
import {
    EmptyState,
    ErrorNotice,
    formatMetric,
    GroupedDirectory,
    LoadingState,
    SearchInput,
    SectionPanel,
    SortControl,
    SummaryStrip,
    useInventorySort,
} from "@homelab/ui";
import { Boxes } from "lucide-react";
import { type ReactNode, useState } from "react";

import { ApplicationReadings } from "../infrastructure/ApplicationReadings";
import { resourceStateLabels } from "../infrastructure/resourceStateLabels";
import { ResourceStatus } from "../infrastructure/ResourceStatus";
import { ApplicationActions } from "./ApplicationActions";
import { applicationDirectory } from "./applicationDirectory";
import { ApplicationInspector } from "./ApplicationInspector";
import { ApplicationStatus } from "./ApplicationStatus";
import { ContainerActions } from "./ContainerActions";
import { useApplicationControl } from "./useApplicationControl";

const projectKey = (host: string, project: string) => JSON.stringify([host, project]);

/** Present monitored services, managed containers and Compose projects in one searchable directory.
 * @returns Resource measurements, inspection and the controls reported by each worker.
 */
export function ApplicationCatalog({
    inventory,
    stale,
    loading,
}: {
    readonly inventory: InfrastructureInventory | null | undefined;
    readonly stale: boolean;
    readonly loading: boolean;
}) {
    const control = useApplicationControl();
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState<string>();
    const entries = applicationDirectory(
        inventory?.applications ?? [],
        control.containers
    );
    const active = entries.find((entry) => entry.id === selected);
    const matches = (value: string) =>
        value.toLowerCase().includes(search.trim().toLowerCase());
    const rows = entries.filter((row) =>
        matches(
            [
                row.name,
                row.host,
                row.project,
                row.container?.containerName,
                row.container?.image,
            ].join(" ")
        )
    );
    const members = Map.groupBy(control.containers, (row) =>
        projectKey(row.host, row.project)
    );
    const cores = (host: string) =>
        inventory?.hosts.find((row) => row.host === host)?.cores ?? null;
    const { ordered, control: sort } = useInventorySort(rows, [
        {
            label: "Project",
            value: (row) => [row.project, row.host, row.name].join(" / "),
        },
        { label: "Application", value: (row) => row.name },
        { label: "Host", value: (row) => row.host },
        {
            label: "Monitoring health",
            value: (row) => (stale ? null : row.metric?.state),
        },
        {
            label: "Container status",
            value: (row) => row.container?.health ?? row.container?.state,
        },
        { label: "CPU", value: (row) => row.metric?.resources?.cpuPercent },
        { label: "Memory", value: (row) => row.metric?.resources?.memoryUsed },
        { label: "Restarts", value: (row) => row.metric?.restarts },
        { label: "Image", value: (row) => row.container?.image },
        {
            label: "Project size",
            value: (row) => members.get(projectKey(row.host, row.project))?.length,
        },
    ]);
    const allEntries = Map.groupBy(entries, (row) => projectKey(row.host, row.project));
    const groups = new Map<
        string,
        { label: string; detail: string; action?: ReactNode; total: number }
    >();
    for (const row of ordered)
        groups.set(projectKey(row.host, row.project), {
            label: row.project || "No project reported",
            detail: row.host,
            total: allEntries.get(projectKey(row.host, row.project))?.length ?? 0,
        });
    for (const project of control.projects) {
        const key = projectKey(project.host, project.name);
        if (groups.has(key) || matches(project.host + " " + project.name))
            groups.set(key, {
                label: project.name,
                detail: project.host,
                total: allEntries.get(key)?.length ?? 0,
                action: (
                    <ApplicationActions
                        host={project.host}
                        selection={{ kind: "project", target: project.name }}
                        revision={project.revision}
                        name={`project ${project.name} on ${project.host}`}
                        states={(members.get(key) ?? []).map((row) => row.state)}
                        disabled={!control.available(project.host)}
                    />
                ),
            });
    }
    const monitored = inventory?.applications;
    const managed = control.query.data?.inventory;
    const healthy = stale
        ? "—"
        : monitored?.filter((item) => item.state === "healthy").length;
    return (
        <SectionPanel
            title="Applications"
            icon={Boxes}
            actions={<SortControl label="applications" {...sort} />}
        >
            {(monitored || managed) && (
                <SummaryStrip
                    label="Application inventory"
                    items={[
                        {
                            label: "Healthy / monitored",
                            value: monitored ? `${healthy} / ${monitored.length}` : "—",
                        },
                        {
                            label: "Managed containers",
                            value: managed ? control.containers.length : "—",
                        },
                        {
                            label: "Compose projects",
                            value: managed ? control.projects.length : "—",
                        },
                        {
                            label: "Managed hosts",
                            value: managed ? control.hosts.length : "—",
                        },
                    ]}
                />
            )}
            <SearchInput
                value={search}
                onChange={setSearch}
                label="Search applications"
                clearLabel="Clear application search"
                placeholder="Find an application, image, project or host…"
            />
            {(control.query.isPending || loading) && (
                <LoadingState label="Loading application inventory…" />
            )}
            {control.query.isError && <ErrorNotice error={control.query.error} />}
            {control.query.data && !control.query.data.configured && (
                <p className="text-sm text-primary-400">
                    Container control is not configured.
                </p>
            )}
            {control.query.data?.configured &&
                (!control.query.data.fresh ||
                    control.hosts.some((host) => !host.available)) && (
                    <p className="text-sm text-amber-300">
                        Container controls are unavailable on hosts without a fresh worker
                        observation.
                    </p>
                )}
            <GroupedDirectory
                ordered
                items={ordered}
                group={(row) => projectKey(row.host, row.project)}
                groupInfo={groups}
                getKey={(row) => row.id}
                name={(row) => row.name}
                detail={(row) => (
                    <>
                        {row.container && (
                            <span className="block truncate" title={row.container.image}>
                                {row.container.image.split("@")[0]}
                            </span>
                        )}
                        {row.metric ? (
                            <span>
                                {
                                    resourceStateLabels[
                                        stale ? "unknown" : row.metric.state
                                    ]
                                }{" "}
                                · Restarts{" "}
                                {formatMetric(stale ? null : row.metric.restarts)}
                            </span>
                        ) : (
                            row.container?.containerName
                        )}
                    </>
                )}
                status={(row) =>
                    row.metric ? (
                        <ResourceStatus
                            marker
                            state={stale ? "unknown" : row.metric.state}
                        />
                    ) : (
                        row.container && (
                            <ApplicationStatus
                                available={control.available(row.host)}
                                state={row.container.state}
                                health={row.container.health}
                            />
                        )
                    )
                }
                readings={(row) =>
                    row.metric ? (
                        <ApplicationReadings
                            application={row.metric}
                            stale={stale}
                            cores={cores(row.host)}
                        />
                    ) : (
                        <span className="text-xs text-primary-400">
                            No monitoring observation
                        </span>
                    )
                }
                actions={(row) =>
                    row.container && (
                        <ContainerActions
                            container={row.container}
                            available={control.available(row.host)}
                        />
                    )
                }
                onSelect={(row) => setSelected(row.id)}
            />
            {groups.size === 0 && !loading && !control.query.isPending && (
                <EmptyState
                    icon={Boxes}
                    title={
                        search ? "No matching applications" : "No applications reported"
                    }
                />
            )}
            {active && (
                <ApplicationInspector
                    key={active.id}
                    entry={active}
                    capturedAt={inventory?.capturedAt}
                    cores={cores(active.host)}
                    stale={stale}
                    available={control.available(active.host)}
                    logsAvailable={control.logsAvailable(active.host)}
                    onClose={() => setSelected(undefined)}
                />
            )}
        </SectionPanel>
    );
}
