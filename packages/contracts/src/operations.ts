import * as v from "valibot";

import { capabilities, capabilitySchema, type Capability } from "./permissions";
import {
    scheduleConfigurationSchema,
    disableReasonSchema,
    type ResourceClass,
    type ScheduleConfiguration,
} from "./schedules";
import { tableSortSchema, tableCursorSchema } from "./tableSort";
export {
    capabilities,
    capabilitySchema,
    capabilityDetails,
    type Capability,
} from "./permissions";
export {
    scheduleConfigurationSchema,
    describeSchedule,
    resourceClasses,
    type ResourceClass,
    type ScheduleConfiguration,
} from "./schedules";
export const labelSchema = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(80),
    v.regex(/^[^\p{Cc}]+$/u)
);
export const idSchema = v.pipe(v.string(), v.uuid());
export const pageSchema = v.strictObject({
    before: v.optional(idSchema),
    limit: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
        30
    ),
});
export const jobStates = [
    "queued",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
] as const;
export type JobState = (typeof jobStates)[number];
export const createAutomationSchema = v.strictObject({
    label: labelSchema,
    capabilities: v.pipe(
        v.array(capabilitySchema),
        v.minLength(1),
        v.maxLength(capabilities.length),
        v.check(
            (values) => new Set(values).size === values.length,
            "Choose each permission only once."
        )
    ),
    expiresAt: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const updateAutomationSchema = v.strictObject({
    id: idSchema,
    version: v.pipe(v.number(), v.integer(), v.minValue(1)),
    capabilities: createAutomationSchema.entries.capabilities,
});
export const versionedIdSchema = v.strictObject({
    id: idSchema,
    version: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export const runJobSchema = v.strictObject({
    action: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
    requestId: idSchema,
    payload: v.optional(v.unknown()),
});
export const scheduleUpdateSchema = v.strictObject({
    id: idSchema,
    version: v.pipe(v.number(), v.integer(), v.minValue(1)),
    schedule: scheduleConfigurationSchema,
});
export const scheduleStateSchema = v.pipe(
    v.strictObject({
        ...versionedIdSchema.entries,
        enabled: v.boolean(),
        reason: v.nullable(disableReasonSchema),
        until: v.nullable(
            v.pipe(
                v.number(),
                v.integer(),
                v.minValue(1),
                v.maxValue(8_640_000_000_000_000)
            )
        ),
    }),
    v.check(
        (input) =>
            input.enabled
                ? input.reason === null && input.until === null
                : input.reason !== null,
        "Disabled schedules require a reason."
    )
);
export const workerControlSchema = v.strictObject({
    version: versionedIdSchema.entries.version,
    paused: v.boolean(),
});
export const runFilterSchema = v.strictObject({
    sort: v.optional(
        tableSortSchema(["job", "state", "size", "attempt", "time", "actor"])
    ),
    cursor: v.optional(tableCursorSchema),
    ...pageSchema.entries,
    action: v.optional(runJobSchema.entries.action),
    view: v.optional(v.picklist(["all", "active", "recent"]), "all"),
});
export interface WorkerControl {
    readonly paused: boolean;
    readonly version: number;
    readonly updatedAt: string | null;
    readonly updatedBy: string | null;
}

export interface AutomationAccount {
    readonly id: string;
    readonly label: string;
    readonly capabilities: Capability[];
    readonly version: number;
    readonly disabledAt: string | null;
    readonly createdAt: string;
}
export interface AutomationCredential {
    readonly id: string;
    readonly accountId: string;
    readonly prefix: string;
    readonly createdAt: string;
    readonly expiresAt: string | null;
    readonly revokedAt: string | null;
    readonly lastUsedAt: string | null;
}
export interface JobSummary {
    readonly id: string;
    readonly action: string;
    readonly label: string;
    readonly resourceClass: ResourceClass;
    readonly state: JobState;
    readonly attempt: number;
    readonly attemptLimit: number;
    readonly requestedBy: string;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly message: string | null;
    readonly cancelRequested: boolean;
}
export interface ScheduleSummary {
    readonly id: string;
    readonly action: string;
    readonly label: string;
    readonly description: string;
    readonly resourceClass: ResourceClass;
    readonly attemptLimit: number;
    readonly timeoutMs: number;
    readonly manualRunAvailable: boolean;
    readonly activeRun: { id: string; state: "queued" | "running" } | null;
    readonly enabled: boolean;
    readonly disableReason: string | null;
    readonly disabledUntil: string | null;
    readonly schedule: ScheduleConfiguration;
    readonly nextRunAt: string;
    readonly version: number;
}
export interface InfrastructureSnapshot {
    readonly capturedAt: string;
    readonly reachableTargets: number;
    readonly totalTargets: number;
    readonly firingAlerts: number | null;
}
