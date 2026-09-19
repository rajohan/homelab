import type { ManagedApplication } from "@homelab/contracts/applications";
import { DataTable, formatDateTime } from "@homelab/ui";

/**
 * Render explicitly selected Docker metadata without exposing environment variables or labels.
 * @returns Safe image, network, port and mount information in bounded responsive tables.
 */
export function ApplicationMetadata({
    application,
}: {
    readonly application: ManagedApplication;
}) {
    return (
        <div className="space-y-5">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm [&_dd]:wrap-anywhere [&_dt]:text-primary-400">
                <dt>Image</dt>
                <dd>{application.image}</dd>
                <dt>Container</dt>
                <dd>{application.containerName}</dd>
                <dt>Container ID</dt>
                <dd>{application.containerId}</dd>
                <dt>Image ID</dt>
                <dd>{application.imageId}</dd>
                <dt>Started</dt>
                <dd>
                    {application.startedAt.startsWith("0001-")
                        ? "Not started"
                        : formatDateTime(application.startedAt)}
                </dd>
                <dt>Networks</dt>
                <dd>{application.networks.join(", ") || "None"}</dd>
            </dl>
            <section className="space-y-2">
                <h3 className="font-medium">Published ports</h3>
                {application.ports.length > 0 ? (
                    <DataTable
                        label="Published ports"
                        rows={application.ports}
                        getKey={(row) =>
                            `${row.hostAddress}:${row.hostPort}:${row.container}`
                        }
                        compact
                        columns={[
                            {
                                id: "container",
                                label: "Container port",
                                mobile: "title",
                                render: (row) => row.container,
                            },
                            {
                                id: "address",
                                label: "Host address",
                                render: (row) => row.hostAddress,
                            },
                            {
                                id: "port",
                                label: "Host port",
                                render: (row) => row.hostPort,
                            },
                        ]}
                    />
                ) : (
                    <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-3 text-sm text-primary-400">
                        No published ports.
                    </p>
                )}
            </section>
            <section className="space-y-2">
                <h3 className="font-medium">Mounts</h3>
                {application.mounts.length > 0 ? (
                    <DataTable
                        label="Mounts"
                        rows={application.mounts}
                        getKey={(row) => row.destination}
                        compact
                        columns={[
                            {
                                id: "destination",
                                label: "Destination",
                                mobile: "title",
                                render: (row) => (
                                    <span className="wrap-anywhere">
                                        {row.destination}
                                    </span>
                                ),
                            },
                            {
                                id: "source",
                                label: "Source",
                                mobile: "wide",
                                render: (row) => (
                                    <span className="wrap-anywhere">{row.source}</span>
                                ),
                            },
                            {
                                id: "access",
                                label: "Access",
                                render: (row) =>
                                    row.readOnly ? "Read only" : "Read / write",
                            },
                            { id: "type", label: "Type", render: (row) => row.type },
                        ]}
                    />
                ) : (
                    <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-3 text-sm text-primary-400">
                        No mounts.
                    </p>
                )}
            </section>
        </div>
    );
}
