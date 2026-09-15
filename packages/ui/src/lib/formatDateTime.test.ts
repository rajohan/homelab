import { expect, test } from "bun:test";

import { formatDateTime, formatDateTimeParts } from "./formatDateTime";

test("uses the same padded local date and 24-hour time everywhere", () => {
    const date = new Date(2026, 0, 2, 3, 4, 5);
    expect(formatDateTimeParts(date)).toEqual(["02.01.2026", "03:04:05"]);
    expect(formatDateTime(date)).toBe("02.01.2026 · 03:04:05");
    expect(formatDateTime(date.toISOString())).toBe(formatDateTime(date.getTime()));
});
test("handles invalid dates without crashing the surrounding interface", () => {
    expect(formatDateTimeParts("invalid")).toEqual(["Unavailable", "—"]);
});
