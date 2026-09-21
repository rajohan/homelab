import { expect, test } from "bun:test";

import { compareTableValues, nextTableSort } from "./tableSorting";

test("column selection cycles ascending, descending and source order", () => {
    const ascending = nextTableSort(null, "size");
    expect(ascending).toEqual({ id: "size", direction: "ascending" });
    const descending = nextTableSort(ascending, "size");
    expect(descending).toEqual({ id: "size", direction: "descending" });
    expect(nextTableSort(descending, "size")).toBeNull();
    expect(nextTableSort(descending, "name")).toEqual({
        id: "name",
        direction: "ascending",
    });
});

test("raw numeric values sort numerically and unavailable values remain last in both directions", () => {
    for (const direction of ["ascending", "descending"] as const) {
        const rows = [null, 100, 2, undefined, Number.NaN].toSorted((a, b) =>
            compareTableValues(a, b, direction)
        );
        expect(rows.slice(0, 2)).toEqual(direction === "ascending" ? [2, 100] : [100, 2]);
        expect(compareTableValues(null, 1, direction)).toBeGreaterThan(0);
        expect(compareTableValues(1, null, direction)).toBeLessThan(0);
    }
    expect(compareTableValues("Host 2", "host 10", "ascending")).toBeLessThan(0);
    expect(compareTableValues("APP", "app", "ascending")).toBe(0);
});
