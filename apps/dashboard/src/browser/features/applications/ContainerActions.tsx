import type { ManagedApplication } from "@homelab/contracts/applications";

import { ApplicationActions } from "./ApplicationActions";

/** Keep each container action tied to the worker's exact target, revision and affected neighbours.
 * @returns The existing confirmed lifecycle actions for this container.
 */
export function ContainerActions({
    container,
    available,
}: {
    readonly container: ManagedApplication;
    readonly available: boolean;
}) {
    return (
        <ApplicationActions
            host={container.host}
            selection={{ kind: "container", target: container.containerId }}
            revision={container.actionRevision ?? container.revision}
            relatedApplications={container.relatedApplications ?? []}
            name={container.name}
            states={[container.state]}
            disabled={!available}
        />
    );
}
