import type { JobState } from "@homelab/contracts/operations";
import { Badge } from "@homelab/ui";

const tones = {
    queued: "neutral",
    running: "neutral",
    succeeded: "positive",
    failed: "danger",
    timed_out: "danger",
    cancelled: "neutral",
} as const;

/**
 * Keep run state presentation consistent across tables and details.
 * @returns A compact semantic status badge that never stretches in mobile rows.
 */
export function JobStatus({ state }: { readonly state: JobState }) {
    return (
        <Badge tone={tones[state]}>
            <span className="capitalize">{state.replaceAll("_", " ")}</span>
        </Badge>
    );
}
