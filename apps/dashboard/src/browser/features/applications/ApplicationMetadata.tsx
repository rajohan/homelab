import type { ManagedApplication } from "@homelab/contracts/applications";
import {
    DetailEntry,
    DetailFacts,
    DetailList,
    DetailSection,
    formatDateTime,
} from "@homelab/ui";
import { Box, Folder, Network } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Render explicitly selected Docker metadata without exposing environment variables or labels.
 * @returns Safe image, network, port and mount information in bounded responsive tables.
 */
export function ApplicationMetadata({
    application,
    status,
    actions,
    prefix,
}: {
    readonly prefix: string;
    readonly status: ReactNode;
    readonly actions: ReactNode;
    readonly application: ManagedApplication;
}) {
    return (
        <div className="space-y-5">
            <DetailSection
                icon={Box}
                title="Container details"
                actions={actions}
                anchor={prefix + "-details"}
            >
                <DetailFacts
                    items={[
                        { label: "Container status", value: status },
                        { label: "Image", value: application.image },
                        { label: "Container", value: application.containerName },
                        { label: "Container ID", value: application.containerId },
                        { label: "Image ID", value: application.imageId },
                        {
                            label: "Started",
                            value: application.startedAt.startsWith("0001-")
                                ? "Not started"
                                : formatDateTime(application.startedAt),
                        },
                        {
                            label: "Networks",
                            value: application.networks.join(", ") || "None",
                        },
                    ]}
                />
            </DetailSection>
            <DetailList
                icon={Network}
                title="Published ports"
                anchor={prefix + "-ports"}
                rows={application.ports}
                getKey={(row) => `${row.hostAddress}:${row.hostPort}:${row.container}`}
                sorts={[
                    { label: "Container port", value: (row) => row.container },
                    { label: "Host address", value: (row) => row.hostAddress },
                    { label: "Host port", value: (row) => Number(row.hostPort) },
                ]}
                empty="No published ports."
                render={(row) => (
                    <DetailEntry name={row.container} description="Container port">
                        <DetailFacts
                            inline
                            items={[
                                { label: "Host address", value: row.hostAddress },
                                { label: "Host port", value: row.hostPort },
                            ]}
                        />
                    </DetailEntry>
                )}
            />
            <DetailList
                icon={Folder}
                title="Mounts"
                anchor={prefix + "-mounts"}
                rows={application.mounts}
                getKey={(row) => row.destination}
                sorts={[
                    { label: "Destination", value: (row) => row.destination },
                    { label: "Source", value: (row) => row.source },
                    { label: "Access", value: (row) => row.readOnly },
                    { label: "Type", value: (row) => row.type },
                ]}
                empty="No mounts."
                render={(row) => (
                    <DetailEntry name={row.destination} description={row.type} wideName>
                        <DetailFacts
                            items={[
                                { label: "Source", value: row.source },
                                {
                                    label: "Access",
                                    value: row.readOnly ? "Read only" : "Read / write",
                                },
                            ]}
                        />
                    </DetailEntry>
                )}
            />
        </div>
    );
}
