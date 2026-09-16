import { expect, test } from "bun:test";

import { assertCoverageInventory } from "./coverageInventory";

test("coverage rejects missing runtime files rather than silently excluding them", () => {
    const lcov = "SF:apps/auth/index.ts\nLF:2\nLH:1\nend_of_record\n";
    expect(() =>
        assertCoverageInventory(lcov, ["apps/auth/index.ts"], "/repo")
    ).not.toThrow();
    expect(() =>
        assertCoverageInventory(lcov, ["apps/auth/index.ts", "apps/unloaded.ts"], "/repo")
    ).toThrow("apps/unloaded.ts");
    expect(() => assertCoverageInventory(lcov, [], "/repo")).toThrow("empty");
    expect(() =>
        assertCoverageInventory(
            lcov.replace("SF:apps", "SF:/repo/apps"),
            ["apps/auth/index.ts"],
            "/repo"
        )
    ).not.toThrow();
});
