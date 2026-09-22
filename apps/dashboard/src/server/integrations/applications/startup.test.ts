import { expect, test } from "bun:test";
import path from "node:path";

import cases from "../../../../../../scripts/fixtures/dockerStartup.json";
import { startupCodePaths } from "./startup";

test.each(cases)("startup code positions: $name", (scenario) => {
    const paths = startupCodePaths(
        scenario.entrypoint,
        scenario.command,
        scenario.working_dir,
        undefined,
        "environment" in scenario ? scenario.environment : undefined
    );
    const mount = path.posix.normalize(scenario.mount);
    expect(
        paths === null ||
            paths.some((item) => item === mount || item.startsWith(mount + "/"))
    ).toBe(scenario.blocked);
    expect(paths?.join("\n") ?? "").not.toContain("SYNTHETIC_PRIVATE");
});

test("nested startup wrappers remain bounded", () => {
    expect(
        startupCodePaths(
            Array.from({ length: 12 }, () => "exec"),
            ["python", "-m", "app"],
            "/custom"
        )
    ).toBeNull();
});
