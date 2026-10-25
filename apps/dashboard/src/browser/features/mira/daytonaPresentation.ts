import type { MiraDaytonaJob } from "@homelab/contracts/miraDaytona";
export const daytonaTones: Record<
    MiraDaytonaJob["state"],
    "neutral" | "positive" | "warning"
> = {
    draft: "neutral",
    queued: "neutral",
    running: "neutral",
    completed: "positive",
    failed: "warning",
    cancelled: "neutral",
    needs_attention: "warning",
};
export const daytonaCleanupLabels = {
    confirmed: "Confirmed",
    operator_confirmed: "Confirmed by operator",
    pending: "Pending",
    not_needed: "No sandbox requested",
} as const;
export const daytonaCleanupDescriptions = {
    confirmed: "Sandbox cleanup confirmed",
    operator_confirmed: "Cleanup confirmed by operator",
    pending: "Sandbox cleanup pending",
    not_needed: "No sandbox requested",
} as const;

export const daytonaPhaseLabels: Record<string, string> = {
    idle: "Awaiting review",
    admitted: "Preparing job",
    creating: "Starting sandbox",
    waiting: "Waiting for sandbox",
    opening: "Preparing job",
    inputs: "Copying inputs",
    uploading: "Copying inputs",
    ready: "Preparing command",
    submitting: "Starting command",
    executing: "Running command",
    collecting: "Saving results",
    cleaning: "Removing sandbox",
    closed: "Finished",
};
