import { expect, test } from "bun:test";

import { dateTimePickerValue, dateTimePickerTimestamp } from "./dateTimeValue";

test("date/time values round-trip at minute precision and reject invalid selections", () => {
    const original = new Date(2026, 8, 17, 23, 45, 50);
    const value = dateTimePickerValue(original);
    expect(value.time).toBe("23:45");
    expect(dateTimePickerTimestamp(value)).toBe(new Date(2026, 8, 17, 23, 45).getTime());
    expect(dateTimePickerTimestamp({ date: original, time: "25:00" })).toBeNaN();
    expect(
        dateTimePickerTimestamp({ date: new Date(Number.NaN), time: "12:00" })
    ).toBeNaN();
});
