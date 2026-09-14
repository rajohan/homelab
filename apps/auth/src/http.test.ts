import { describe, expect, test } from "bun:test";

import { authBindOptions, authRequest } from "./http";

describe("auth foundation", () => {
    test("uses a separate loopback listener by default", () => {
        expect(authBindOptions({})).toEqual({ hostname: "127.0.0.1", port: 3101 });
    });

    test("requires valid explicit listener overrides", () => {
        expect(
            authBindOptions({ HOMELAB_AUTH_HOST: "::", HOMELAB_AUTH_PORT: "4101" })
        ).toEqual({
            hostname: "::",
            port: 4101,
        });
        expect(() => authBindOptions({ HOMELAB_AUTH_PORT: "65536" })).toThrow();
        expect(() => authBindOptions({ HOMELAB_AUTH_HOST: "*" })).toThrow();
    });

    test("cannot mistake an authentication probe for a successful authorization", () => {
        for (const path of [
            "/authorize",
            "/token",
            "/authz",
            "/api/authz/forward-auth",
        ]) {
            const response = authRequest(
                new Request(`http://localhost${path}`, {
                    headers: { "X-Forwarded-User": "rajohan" },
                })
            );
            expect(response.status).toBe(503);
            expect(response.headers.get("Set-Cookie")).toBeNull();
        }
    });
});
