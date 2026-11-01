import { describe, expect, test } from "bun:test";

import { testArguments } from "./command";
import { discoverTests } from "./inventory";

describe("test selection", () => {
    test("discovers files without a manually maintained inventory", () => {
        const groups = discoverTests();
        expect(groups.unit).toContain("scripts/testing/inventory.test.ts");
        expect(groups.integration.length).toBeGreaterThan(0);
        expect(groups.component.length).toBeGreaterThan(0);
        const all = Object.values(groups).flat();
        expect(new Set(all).size).toBe(all.length);
        expect(all.some((file) => /\/(dist|node_modules)\//.test(file))).toBe(false);
        expect(groups.unit.some((file) => file.includes(".integration."))).toBe(false);
        expect(groups.component.every((file) => file.endsWith(".tsx"))).toBe(true);
    });
    test("keeps DOM setup out of HTTP tests and separates coverage output", () => {
        for (const group of ["unit", "component", "integration"] as const) {
            for (const coverage of [true, false]) {
                const args = testArguments(group, ["a.test.ts"], coverage);
                expect(args.includes("./tests/dom.ts")).toBe(group === "component");
                expect(args.includes("./tests/coverage.ts")).toBe(
                    coverage && group !== "integration"
                );
                expect(args.includes(`--coverage-dir=coverage/${group}`)).toBe(coverage);
                expect(args).toContain("./a.test.ts");
            }
            expect(() => testArguments(group, [], false)).toThrow("empty");
        }
    });
});
