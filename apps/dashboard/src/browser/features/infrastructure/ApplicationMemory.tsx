import type { ApplicationResources } from "@homelab/contracts/infrastructure";

import { ResourceUsage } from "./ResourceUsage";

/**
 * Show application usage against its effective capacity, including the host RAM ceiling.
 * @returns A used/total capacity bar or an explicit unavailable state.
 */
export function ApplicationMemory({
    resources,
}: {
    readonly resources: ApplicationResources | undefined;
}) {
    if (!resources) return <span className="text-primary-400">Not reported</span>;
    return <ResourceUsage used={resources.memoryUsed} total={resources.memoryCapacity} />;
}
