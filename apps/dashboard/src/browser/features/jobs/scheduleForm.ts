import {
    scheduleConfigurationSchema,
    type ScheduleConfiguration,
} from "@homelab/contracts/operations";
import type { FieldDefinition, FormValues } from "@homelab/ui";
import * as v from "valibot";

/**
 * Describe the single input relevant to the selected cadence.
 * @param kind - Selected schedule type.
 * @param current - Persisted configuration used when editing its existing type.
 * @returns Shared form field definitions without independent copies of validation rules.
 */
export function scheduleFields(
    kind: ScheduleConfiguration["kind"],
    current: ScheduleConfiguration
): FieldDefinition[] {
    if (kind === "daily")
        return [
            {
                name: "time",
                label: "Time",
                type: "time",
                initial: current.kind === "daily" ? current.time : "04:00",
            },
        ];
    if (kind === "cron")
        return [
            {
                name: "expression",
                label: "Cron expression",
                placeholder: "0 4 * * *",
                initial: current.kind === "cron" ? current.expression : "0 4 * * *",
                maximum: 200,
            },
        ];
    return [
        {
            name: "minutes",
            label: "Interval in minutes",
            initial:
                current.kind === "interval" ? String(current.intervalSeconds / 60) : "60",
            maximum: 12,
            placeholder: "For example, 60",
        },
    ];
}

/**
 * Convert UI values into the same discriminated contract consumed by the API.
 * @param kind - Selected schedule type.
 * @param values - Shared form values.
 * @returns The candidate schedule, subject to contract validation before submission.
 */
export function scheduleFromValues(
    kind: ScheduleConfiguration["kind"],
    values: FormValues
): ScheduleConfiguration {
    if (kind === "daily") return { kind, time: values.time ?? "" };
    if (kind === "cron") return { kind, expression: values.expression ?? "" };
    return { kind, intervalSeconds: Number(values.minutes) * 60 };
}

/**
 * Validate schedule shape while leaving semantic cron evaluation to the server.
 * @param kind - Selected schedule type.
 * @param values - Current edited values.
 * @returns A field-local error or an empty map.
 */
export function validateScheduleValues(
    kind: ScheduleConfiguration["kind"],
    values: FormValues
): Record<string, string> {
    if (
        v.safeParse(scheduleConfigurationSchema, scheduleFromValues(kind, values)).success
    )
        return {};
    if (kind === "daily") return { time: "Enter a time from 00:00 to 23:59." };
    if (kind === "cron")
        return { expression: "Enter a cron expression with five fields." };
    return { minutes: "Enter an interval from 1 to 43200 minutes, in whole seconds." };
}
