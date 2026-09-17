import * as v from "valibot";

export const scheduleConfigurationSchema = v.variant("kind", [
    v.strictObject({
        kind: v.literal("interval"),
        intervalSeconds: v.pipe(
            v.number(),
            v.integer(),
            v.minValue(60),
            v.maxValue(2_592_000)
        ),
    }),
    v.strictObject({
        kind: v.literal("daily"),
        time: v.pipe(v.string(), v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
    }),
    v.strictObject({
        kind: v.literal("cron"),
        expression: v.pipe(
            v.string(),
            v.trim(),
            v.minLength(9),
            v.maxLength(200),
            v.check(
                (text) => text.split(/\s+/).length === 5,
                "Use a five-field cron expression."
            )
        ),
    }),
]);
export type ScheduleConfiguration = v.InferOutput<typeof scheduleConfigurationSchema>;
export const disableReasonSchema = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(1000),
    v.regex(/^[^\p{Cc}]+$/u)
);
export const resourceClasses = [
    "light",
    "network",
    "interactive",
    "host-heavy",
    "exclusive",
] as const;
export type ResourceClass = (typeof resourceClasses)[number];

/**
 * Describe a schedule without duplicating cadence presentation across views.
 * @param schedule - The validated stored configuration.
 * @returns A human-readable description using the shared system clock.
 */
export function describeSchedule(schedule: ScheduleConfiguration): string {
    if (schedule.kind === "daily") return `Daily at ${schedule.time}`;
    if (schedule.kind === "cron") return `Cron: ${schedule.expression}`;
    return `Every ${schedule.intervalSeconds / 60} minutes`;
}
