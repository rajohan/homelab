import { describe, expect, test } from "bun:test";

import { builtInvocation } from "./builtRuntime";

describe("built smoke runtime", () => {
    test("keeps artifact runs isolated from inherited credentials", () => {
        const invocation = builtInvocation(
            "auth",
            ["index.js"],
            { NODE_ENV: "production" },
            undefined,
            "unused"
        );
        expect(invocation.cmd).toEqual([process.execPath, "index.js"]);
        expect(invocation.env).toEqual({ NODE_ENV: "production" });
        expect(invocation.cwd).toEndWith("/apps/auth/dist/");
    });

    test("runs the tested image read-only and forwards values only in the environment", () => {
        const environment = {
            NODE_ENV: "production",
            HOMELAB_AUTH_COOKIE_KEY: "synthetic-cookie-secret",
        };
        const invocation = builtInvocation(
            "auth",
            ["--no-env-file", "index.js"],
            environment,
            "homelab-release",
            "test-only"
        );
        expect(invocation.cmd).toContain("homelab-release/auth:tested");
        expect(invocation.cmd).toContain("--read-only");
        expect(invocation.cmd).toContain("no-new-privileges");
        expect(invocation.cmd).toContain("HOMELAB_AUTH_COOKIE_KEY");
        expect(invocation.cmd.join(" ")).not.toContain(
            environment.HOMELAB_AUTH_COOKIE_KEY
        );
        expect(invocation.env.HOMELAB_AUTH_COOKIE_KEY).toBe(
            environment.HOMELAB_AUTH_COOKIE_KEY
        );
        expect(invocation.cwd).toBeUndefined();
    });

    test("mounts only the explicit fixture policy and preserves the caller's configuration", () => {
        const environment = { HOMELAB_AUTH_POLICY_FILE: "/repo/tests/access-policy.yml" };
        const invocation = builtInvocation(
            "auth",
            ["admin.js", "migrate"],
            environment,
            "homelab-release",
            "test-only"
        );
        expect(invocation.cmd).toContain(
            "type=bind,source=/repo/tests/access-policy.yml,target=/etc/homelab-smoke-policy.yml,readonly"
        );
        expect(invocation.env.HOMELAB_AUTH_POLICY_FILE).toBe(
            "/etc/homelab-smoke-policy.yml"
        );
        expect(environment.HOMELAB_AUTH_POLICY_FILE).toBe(
            "/repo/tests/access-policy.yml"
        );
    });

    test("dashboard containers need no policy or source mount", () => {
        const invocation = builtInvocation(
            "dashboard",
            ["index.js"],
            {},
            "homelab-release",
            "test-only"
        );
        expect(invocation.cmd).toContain("homelab-release/dashboard:tested");
        expect(invocation.cmd).not.toContain("--mount");
    });

    test("rejects an invalid image namespace", () => {
        expect(() =>
            builtInvocation("auth", [], {}, "image; command", "test-only")
        ).toThrow("Invalid smoke image namespace.");
    });
});
