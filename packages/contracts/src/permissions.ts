import * as v from "valibot";

export const capabilityDetails = {
    "jobs:read": {
        group: "Jobs",
        label: "View job runs",
        description: "Read run history, status and safe diagnostic details.",
    },
    "jobs:run": {
        group: "Jobs",
        label: "Run jobs",
        description:
            "Queue registered jobs; each action also requires its own permission.",
    },
    "jobs:cancel": {
        group: "Jobs",
        label: "Cancel jobs",
        description: "Cancel waiting jobs or request cancellation of running work.",
    },
    "schedules:read": {
        group: "Schedules",
        label: "View schedules",
        description: "Read schedules, disable reasons and next run times.",
    },
    "schedules:write": {
        group: "Schedules",
        label: "Manage schedules",
        description: "Change cadence or enable and disable automatic runs.",
    },
    "worker:read": {
        group: "Worker",
        label: "View worker status",
        description: "Read worker health, capacity and queue totals.",
    },
    "worker:control": {
        group: "Worker",
        label: "Pause and resume workers",
        description: "Control new job execution across the worker pool.",
    },
    "infrastructure:read": {
        group: "Infrastructure",
        label: "Read infrastructure summaries",
        description: "Read the collected monitoring summary.",
    },
    "infrastructure:refresh": {
        group: "Infrastructure",
        label: "Refresh infrastructure data",
        description: "Allow the monitoring collection job; also requires Run jobs.",
    },
    "operations:maintain": {
        group: "Maintenance",
        label: "Run history maintenance",
        description: "Allow operational history cleanup; also requires Run jobs.",
    },
} as const;
export type Capability = keyof typeof capabilityDetails;
export const capabilities = Object.keys(capabilityDetails) as Capability[];
export const capabilitySchema = v.picklist(capabilities);
