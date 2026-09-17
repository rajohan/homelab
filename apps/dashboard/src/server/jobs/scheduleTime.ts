import {
    scheduleConfigurationSchema,
    type ScheduleConfiguration,
} from "@homelab/contracts/operations";
import { Cron, Result } from "effect";
import * as v from "valibot";

/**
 * Compute the first future occurrence in the system's shared time zone.
 * @param configuration - One complete daily, interval or five-field cron schedule.
 * @param after - Exclusive lower bound in milliseconds.
 * @param anchor - Original interval occurrence, retained to prevent cadence drift.
 * @param timeZone - System clock override for deterministic tests, never a per-job setting.
 * @returns A valid next occurrence; invalid or impossible schedules throw before persistence.
 */
export function nextScheduleOccurrence(
    configuration: ScheduleConfiguration,
    after: number,
    anchor = after,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
): Date {
    const schedule = v.parse(scheduleConfigurationSchema, configuration);
    if (!Number.isFinite(after) || !Number.isFinite(anchor))
        throw new Error("Invalid schedule clock");
    if (schedule.kind === "interval") {
        const interval = schedule.intervalSeconds * 1000;
        const result = new Date(
            anchor > after
                ? anchor
                : anchor + (Math.floor((after - anchor) / interval) + 1) * interval
        );
        if (!Number.isFinite(result.getTime()))
            throw new Error("Schedule exceeds the supported date range");
        return result;
    }
    const expression =
        schedule.kind === "daily"
            ? `${Number(schedule.time.slice(3))} ${Number(schedule.time.slice(0, 2))} * * *`
            : schedule.expression;
    const parsed = Cron.parse(expression, timeZone);
    if (Result.isFailure(parsed)) throw new Error("Invalid cron expression");
    const result = Cron.next(parsed.success, new Date(after));
    if (result.getTime() <= after || !Number.isFinite(result.getTime()))
        throw new Error("Schedule has no future occurrence");
    return result;
}
