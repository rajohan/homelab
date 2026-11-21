import type { ResourceState } from "@homelab/contracts/infrastructure";
import { Badge } from "@homelab/ui";
import { CircleCheck, CircleHelp, CirclePause, TriangleAlert } from "lucide-react";

import { resourceStateLabels } from "./resourceStateLabels";

const stateMarkers = {
    healthy: { icon: CircleCheck, color: "text-emerald-300" },
    unhealthy: { icon: TriangleAlert, color: "text-rose-300" },
    stopped: { icon: CirclePause, color: "text-primary-400" },
    unknown: { icon: CircleHelp, color: "text-amber-300" },
};

/**
 * Distinguish healthy, intentionally stopped and unavailable monitoring states.
 * @returns A compact shared resource status badge.
 */
export function ResourceStatus({
    state,
    marker = false,
}: {
    readonly state: ResourceState;
    readonly marker?: boolean;
}) {
    if (marker) {
        const { icon: Icon, color } = stateMarkers[state];
        return (
            <span title={resourceStateLabels[state]} className={color}>
                <Icon aria-hidden="true" size={14} />
                <span className="sr-only">{resourceStateLabels[state]}</span>
            </span>
        );
    }
    const tones = {
        healthy: "positive",
        unhealthy: "danger",
        stopped: "neutral",
        unknown: "neutral",
    } as const;
    return <Badge tone={tones[state]}>{resourceStateLabels[state]}</Badge>;
}
