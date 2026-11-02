import type { Badge } from "@homelab/ui";
import type { ComponentProps } from "react";

type Tone = NonNullable<ComponentProps<typeof Badge>["tone"]>;
const tones: Readonly<Record<string, Tone>> = {
    queued: "info",
    queued_verification: "info",
    running: "info",
    streaming: "info",
    sending: "info",
    publishing: "info",
    verifying: "info",
    in_progress: "info",
    stopping: "info",
    completed: "positive",
    succeeded: "positive",
    sent: "positive",
    published: "positive",
    submitted: "positive",
    approved: "positive",
    done: "positive",
    failed: "danger",
    interrupted: "warning",
    blocked: "warning",
    needs_attention: "warning",
    verification_required: "warning",
    awaiting_approval: "warning",
    unknown: "warning",
};

/**
 * Share work-state colors across Mira lists, messages, reports and details.
 * @param state - Persisted state; drafts, deliberate stops and unknown new states stay neutral.
 * @returns A semantic badge tone, never an authorization or health decision.
 */
export function miraStatusTone(state: string): Tone {
    return tones[state] ?? "neutral";
}

/**
 * Color the already freshness-checked access label without changing access decisions.
 * @param label - Effective computer or browser status from its existing presentation helper.
 * @returns Active access in green, transitions in blue, and unavailable or pending approval in amber.
 */
export function accessStatusTone(label: string): Tone {
    if (["View only", "Control"].includes(label)) return "positive";
    if (["Ready to start", "Stopping"].includes(label)) return "info";
    if (["Status unavailable", "Unavailable", "Awaiting local approval"].includes(label))
        return "warning";
    return "neutral";
}
