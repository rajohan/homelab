import * as v from "valibot";

export const capabilityDetails = {
    "updates:apply": {
        group: "Updates",
        label: "Install software updates",
        description:
            "Queue confirmed updates for explicitly configured targets; also requires Run jobs.",
    },
    "updates:configure": {
        group: "Updates",
        label: "Manage automatic updates",
        description:
            "Verified operators can enable patch/minor updates for configured targets. Major updates and host reboots remain manual.",
    },
    "updates:read": {
        group: "Updates",
        label: "Read update inventory",
        description: "Read installed versions, available updates and collection status.",
    },
    "updates:publish": {
        group: "Updates",
        label: "Publish update inventory",
        description:
            "Publish read-only inventory for the source assigned to this automation account.",
    },
    "updates:refresh": {
        group: "Updates",
        label: "Check available versions",
        description: "Allow read-only release and image checks; also requires Run jobs.",
    },
    "alerts:read": {
        group: "Monitoring",
        label: "Read monitoring incidents",
        description:
            "Read active, suppressed and resolved incidents without changing alert delivery.",
    },
    "alerts:refresh": {
        group: "Monitoring",
        label: "Refresh monitoring incidents",
        description: "Allow incident synchronization; also requires Run jobs.",
    },
    "backups:read": {
        group: "Backups",
        label: "Read backup status",
        description:
            "Read backup completion and verification status, without backup data or restore access.",
    },
    "backups:refresh": {
        group: "Backups",
        label: "Refresh backup status",
        description: "Allow backup status collection; also requires Run jobs.",
    },
    "applications:read": {
        group: "Applications",
        label: "Read application details",
        description: "Read safe metadata for configured applications and projects.",
    },
    "applications:logs": {
        group: "Applications",
        label: "Read application logs",
        description: "Read bounded log history for configured applications.",
    },
    "applications:start": {
        group: "Applications",
        label: "Start applications",
        description:
            "Queue confirmed application or project starts; also requires Run jobs.",
    },
    "applications:stop": {
        group: "Applications",
        label: "Stop applications",
        description:
            "Queue confirmed application or project stops; also requires Run jobs.",
    },
    "applications:restart": {
        group: "Applications",
        label: "Restart applications",
        description:
            "Queue confirmed application or project restarts; also requires Run jobs.",
    },
    "notifications:read": {
        group: "Notifications",
        label: "Read notifications",
        description:
            "Read operational notifications without changing acknowledgement state.",
    },
    "notifications:publish": {
        group: "Notifications",
        label: "Publish notifications",
        description:
            "Automation accounts can publish plain-text notifications in their own namespace.",
    },
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
