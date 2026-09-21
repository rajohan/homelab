import {
    Badge,
    Card,
    DataTable,
    ErrorNotice,
    LoadingState,
    PageHeader,
    SearchInput,
    SectionHeader,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Layers } from "lucide-react";
import { useState } from "react";

import { ApplicationActions } from "../features/applications/ApplicationActions";
import { ApplicationInspector } from "../features/applications/ApplicationInspector";
import { ApplicationStatus } from "../features/applications/ApplicationStatus";
import { applicationInventoryOptions } from "../features/applications/queries";

/**
 * Present worker-owned application inventory and explicitly confirmed lifecycle controls.
 * @returns Managed projects and containers with no ambient shell or Docker access.
 */
export function Applications() {
    const query = useQuery(applicationInventoryOptions);
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState<string>();
    const inventory = query.data?.inventory;
    const stale = !inventory || !query.data?.fresh || query.isError;
    const applications = inventory?.hosts.flatMap((host) => host.applications) ?? [];
    const active = applications.find((item) => item.id === selected);
    const matches = (value: string) => value.toLowerCase().includes(search.toLowerCase());
    const unavailable = (host: string) =>
        stale || !inventory?.hosts.find((item) => item.id === host)?.available;
    return (
        <div className="space-y-4">
            <PageHeader
                title="Applications"
                description="Inspect containers, read logs and manage existing Compose projects."
            />
            {query.isPending && <LoadingState label="Loading applications…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {query.data && !query.data.configured && (
                <Card>
                    <p className="text-sm text-primary-400">
                        Application control is not configured. Infrastructure monitoring
                        remains available.
                    </p>
                </Card>
            )}
            {query.data?.configured && (
                <>
                    <SearchInput
                        label="Search managed applications"
                        clearLabel="Clear application search"
                        placeholder="Search applications, projects or hosts…"
                        value={search}
                        onChange={setSearch}
                    />
                    {inventory?.hosts.some((host) => !host.available) && (
                        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
                            One or more application hosts are unavailable. Their actions
                            are disabled.
                        </p>
                    )}
                    <Card className="space-y-4">
                        <SectionHeader
                            title="Compose projects"
                            description="Lifecycle actions affect existing containers, without rebuilding or changing configuration."
                            icon={Layers}
                            badge={
                                <Badge tone={stale ? "warning" : "positive"}>
                                    {stale ? "Stale inventory" : "Live inventory"}
                                </Badge>
                            }
                        />
                        <DataTable
                            label="Compose projects"
                            rows={query.data.projects.filter((row) =>
                                matches(`${row.host} ${row.name}`)
                            )}
                            getKey={(row) => `${row.host}:${row.name}`}
                            compact
                            columns={[
                                {
                                    id: "name",
                                    sortValue: (row) => row.name,
                                    label: "Project",
                                    mobile: "title",
                                    render: (row) => (
                                        <span className="font-semibold">{row.name}</span>
                                    ),
                                },
                                {
                                    id: "host",
                                    sortValue: (row) => row.host,
                                    label: "Host",
                                    render: (row) => row.host,
                                },
                                {
                                    id: "containers",
                                    sortValue: (row) =>
                                        applications.filter(
                                            (item) =>
                                                item.host === row.host &&
                                                item.project === row.name
                                        ).length,
                                    label: "Containers",
                                    render: (row) =>
                                        applications.filter(
                                            (item) =>
                                                item.host === row.host &&
                                                item.project === row.name
                                        ).length,
                                },
                                {
                                    id: "actions",
                                    label: "Actions",
                                    hideLabel: true,
                                    mobile: "actions",
                                    width: "w-16",
                                    render: (row) => (
                                        <ApplicationActions
                                            host={row.host}
                                            selection={{
                                                kind: "project",
                                                target: row.name,
                                            }}
                                            revision={row.revision}
                                            name={row.name}
                                            states={applications
                                                .filter(
                                                    (item) =>
                                                        item.host === row.host &&
                                                        item.project === row.name
                                                )
                                                .map((item) => item.state)}
                                            disabled={unavailable(row.host)}
                                        />
                                    ),
                                },
                            ]}
                        />
                    </Card>
                    <Card className="space-y-4">
                        <SectionHeader
                            title="Containers"
                            description="Select a container for its configuration details and logs."
                            icon={Boxes}
                        />
                        <DataTable
                            label="Managed containers"
                            rows={applications.filter((row) =>
                                matches(
                                    `${row.host} ${row.project} ${row.name} ${row.image}`
                                )
                            )}
                            getKey={(row) => row.id}
                            compact
                            rowAction={{
                                label: (row) => `Inspect ${row.name}`,
                                onSelect: (row) => setSelected(row.id),
                            }}
                            columns={[
                                {
                                    id: "name",
                                    sortValue: (row) => row.name,
                                    label: "Application",
                                    mobile: "title",
                                    render: (row) => (
                                        <div className="font-semibold">
                                            {row.name}
                                            <p className="mt-1 text-xs font-normal text-primary-400">
                                                {row.project}
                                            </p>
                                        </div>
                                    ),
                                },
                                {
                                    id: "host",
                                    sortValue: (row) => row.host,
                                    label: "Host",
                                    render: (row) => row.host,
                                },
                                {
                                    id: "status",
                                    sortValue: (row) => row.state,
                                    label: "Status",
                                    render: (row) => (
                                        <ApplicationStatus
                                            state={row.state}
                                            health={row.health}
                                            available={!unavailable(row.host)}
                                        />
                                    ),
                                },
                                {
                                    id: "image",
                                    sortValue: (row) => row.image,
                                    label: "Image",
                                    mobile: "wide",
                                    render: (row) => (
                                        <span className="wrap-anywhere">{row.image}</span>
                                    ),
                                },
                                {
                                    id: "actions",
                                    label: "Actions",
                                    hideLabel: true,
                                    mobile: "actions",
                                    width: "w-16",
                                    render: (row) => (
                                        <ApplicationActions
                                            host={row.host}
                                            selection={{
                                                kind: "container",
                                                target: row.containerId,
                                            }}
                                            revision={row.actionRevision ?? row.revision}
                                            relatedApplications={
                                                row.relatedApplications ?? []
                                            }
                                            name={row.name}
                                            states={[row.state]}
                                            disabled={unavailable(row.host)}
                                        />
                                    ),
                                },
                            ]}
                        />
                        {applications.length === 0 && (
                            <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                                No managed containers have been discovered yet.
                            </p>
                        )}
                    </Card>
                </>
            )}
            {active && (
                <ApplicationInspector
                    key={active.id}
                    application={active}
                    available={!unavailable(active.host)}
                    logsAvailable={query.data?.logHosts.includes(active.host) ?? false}
                    onClose={() => setSelected(undefined)}
                />
            )}
        </div>
    );
}
