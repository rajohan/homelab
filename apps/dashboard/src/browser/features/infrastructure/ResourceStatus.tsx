import type { ResourceState } from "@homelab/contracts/infrastructure";
import { Badge } from "@homelab/ui";

const labels = {
    healthy: "Healthy",
    unhealthy: "Needs attention",
    stopped: "Stopped",
    unknown: "Unknown",
};

/**
 * Distinguish healthy, intentionally stopped and unavailable monitoring states.
 * @returns A compact shared resource status badge.
 */
export function ResourceStatus({ state }: { readonly state: ResourceState }) {
    const tones = {
        healthy: "positive",
        unhealthy: "danger",
        stopped: "neutral",
        unknown: "neutral",
    } as const;
    return <Badge tone={tones[state]}>{labels[state]}</Badge>;
}
