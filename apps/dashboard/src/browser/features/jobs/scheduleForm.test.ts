import { expect, test } from "bun:test";

import {
    scheduleFields,
    scheduleFromValues,
    validateScheduleValues,
} from "./scheduleForm";

test("schedule form converts all three modes with no per-job time zone", () => {
    expect(scheduleFromValues("daily", { time: "05:45" })).toEqual({
        kind: "daily",
        time: "05:45",
    });
    expect(scheduleFromValues("cron", { expression: "0 4 * * *" })).toEqual({
        kind: "cron",
        expression: "0 4 * * *",
    });
    expect(scheduleFromValues("interval", { minutes: "5" })).toEqual({
        kind: "interval",
        intervalSeconds: 300,
    });
    expect(validateScheduleValues("daily", { time: "25:45" })).toHaveProperty("time");
    expect(validateScheduleValues("cron", { expression: "* *" })).toHaveProperty(
        "expression"
    );
    expect(validateScheduleValues("interval", { minutes: "0" })).toHaveProperty(
        "minutes"
    );
    expect(validateScheduleValues("interval", { minutes: "5" })).toEqual({});
    for (const kind of ["daily", "interval", "cron"] as const) {
        const fields = scheduleFields(kind, { kind: "interval", intervalSeconds: 600 });
        expect(fields).toHaveLength(1);
        expect(fields[0]?.name).not.toBe("timeZone");
    }
});
