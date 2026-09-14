import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { startAuthServer } from "./server";

describe("independent auth HTTP service", () => {
    let server: ReturnType<typeof startAuthServer>;
    let origin: string;

    beforeAll(() => {
        server = startAuthServer({ hostname: "127.0.0.1", port: 0 });
        origin = `http://127.0.0.1:${server.port}`;
    });

    afterAll(() => server.stop(true));

    test("readiness reports only foundation readiness, without the dashboard running", async () => {
        for (const path of ["/", "/health/live", "/health/ready"]) {
            const response = await fetch(`${origin}${path}`);
            expect(response.status).toBe(200);
            expect(response.headers.get("Set-Cookie")).toBeNull();
            expect(await response.json()).toEqual({
                service: "auth",
                status: "ok",
                phase: "foundation",
                authenticationImplemented: false,
            });
        }
    });

    test("OIDC and ForwardAuth are unavailable for every HTTP method", async () => {
        for (const path of [
            "/authorize",
            "/token",
            "/userinfo",
            "/jwks",
            "/introspect",
            "/revoke",
            "/.well-known/openid-configuration",
            "/authz",
            "/api/authz/forward-auth",
        ]) {
            for (const method of ["GET", "POST", "HEAD"]) {
                const response = await fetch(`${origin}${path}`, { method });
                expect(response.status).toBe(503);
                expect(response.headers.get("Cache-Control")).toBe("no-store");
                expect(response.headers.get("Set-Cookie")).toBeNull();
            }
        }
    });

    test("unknown paths fail closed", async () => {
        const response = await fetch(`${origin}/login`);
        expect(response.status).toBe(404);
    });
});
