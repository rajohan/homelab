import { describe, expect, test } from "bun:test";

import { testArguments } from "./command";
import { assertTimings } from "./inventory";

describe("test policy", () => {
    test("requires an exact measured inventory", () => {
        const valid = { version: 1 as const, files: { "a.test.ts": 1 } };
        expect(assertTimings(valid, ["a.test.ts"], "unit")).toEqual(valid);
        expect(() => assertTimings(valid, ["a.test.ts", "b.test.ts"], "unit")).toThrow(
            "Missing: b.test.ts"
        );
        expect(() => assertTimings(valid, ["b.test.ts"], "unit")).toThrow(
            "Stale: a.test.ts"
        );
        for (const duration of [-1, Number.NaN, Infinity, "1"])
            expect(() =>
                assertTimings(
                    { version: 1, files: { "a.test.ts": duration } },
                    ["a.test.ts"],
                    "unit"
                )
            ).toThrow();
    });
    test("enforces parallel execution without isolation in every mode", () => {
        for (const group of ["unit", "component", "integration"] as const)
            for (const coverage of [true, false])
                for (const update of [true, false]) {
                    const args = testArguments(
                        group,
                        ["a.test.ts"],
                        coverage,
                        undefined,
                        update
                    );
                    expect(args).toContain("--parallel=2");
                    expect(args).toContain("--no-isolate");
                    expect(args).not.toContain("--isolate");
                    expect(args.includes("./tests/dom.ts")).toBe(group === "component");
                }
    });
});
