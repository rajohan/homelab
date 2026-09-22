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

test("startup PATH assignments cannot hide an independent healthcheck lookup", () => {
    expect(
        startupCodePaths(
            ["/bin/sh", "-c"],
            ["PATH=/usr/bin /bin/true"],
            "/",
            ["CMD", "start"],
            ["PATH=/custom:/usr/bin"]
        )
    ).toContain("/custom/start");
});

test("runtime scalar options do not turn data operands into modules", () => {
    const paths = startupCodePaths(
        ["node", "--max-old-space-size=128"],
        ["/vendor/app.js", "/custom/config"],
        "/"
    );
    expect(paths).not.toBeNull();
    expect(paths).toContain("/vendor/app.js");
    expect(paths).not.toContain("/custom/config");
});

test("setting PATH alone does not execute a command from that directory", () => {
    for (const body of [
        "export PATH=/custom:/usr/bin; /vendor/server",
        "PATH=/custom:/usr/bin; /vendor/server",
    ]) {
        const paths = startupCodePaths(["/bin/sh", "-c"], [body]);
        expect(paths).not.toBeNull();
        expect(paths?.some((value) => value.startsWith("/custom/"))).toBe(false);
    }
});

test("expanded interpreter options cannot inject a script, but script data stays eligible", () => {
    expect(
        startupCodePaths(["/bin/sh", "-c"], ["python -$OPTIONS /vendor/app.py"])
    ).toBeNull();
    expect(
        startupCodePaths(["/bin/sh", "-c"], ["python /vendor/app.py --mode=$OPTIONS"])
    ).not.toBeNull();
});
