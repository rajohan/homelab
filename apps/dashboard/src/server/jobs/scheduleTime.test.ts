import { expect, test } from "bun:test";

import { nextScheduleOccurrence } from "./scheduleTime";

test("intervals skip missed occurrences without moving their anchor", () => {
    expect(
        nextScheduleOccurrence(
            { kind: "interval", intervalSeconds: 60 },
            185_000,
            10_000
        ).getTime()
    ).toBe(190_000);
    expect(
        nextScheduleOccurrence(
            { kind: "interval", intervalSeconds: 60 },
            10_000,
            10_000
        ).getTime()
    ).toBe(70_000);
});

test("daily schedules follow the shared clock across daylight saving changes", () => {
    const daily = { kind: "daily", time: "02:30" } as const;
    expect(
        nextScheduleOccurrence(
            daily,
            Date.parse("2026-03-29T00:00:00Z"),
            undefined,
            "Europe/Oslo"
        ).toISOString()
    ).toBe("2026-03-29T01:30:00.000Z");
    const first = nextScheduleOccurrence(
        daily,
        Date.parse("2026-10-25T00:00:00Z"),
        undefined,
        "Europe/Oslo"
    );
    expect(first.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(
        nextScheduleOccurrence(
            daily,
            first.getTime(),
            undefined,
            "Europe/Oslo"
        ).toISOString()
    ).toBe("2026-10-26T01:30:00.000Z");
});

test("cron supports weekdays and rejects malformed or impossible schedules", () => {
    expect(
        nextScheduleOccurrence(
            { kind: "cron", expression: "0 9 * * MON-FRI" },
            Date.parse("2026-09-18T10:00:00Z"),
            undefined,
            "UTC"
        ).toISOString()
    ).toBe("2026-09-21T09:00:00.000Z");
    for (const expression of [
        "* * * * * *",
        "61 * * * *",
        "0 0 31 2 *",
        "wrong cron syntax here now",
    ]) {
        expect(() =>
            nextScheduleOccurrence({ kind: "cron", expression }, Date.now())
        ).toThrow();
    }
    expect(() =>
        nextScheduleOccurrence({ kind: "daily", time: "24:00" }, Date.now())
    ).toThrow();
    expect(() =>
        nextScheduleOccurrence({ kind: "interval", intervalSeconds: 1 }, Date.now())
    ).toThrow();
    expect(() =>
        nextScheduleOccurrence({ kind: "interval", intervalSeconds: 60 }, Number.NaN)
    ).toThrow();
});
