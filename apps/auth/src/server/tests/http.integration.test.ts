import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { startAuthServer } from "../index";
describe("unconfigured auth service fails closed", () => {
    let server: Awaited<ReturnType<typeof startAuthServer>>;
    let origin: string;
    beforeAll(async () => {
        server = await startAuthServer({ hostname: "127.0.0.1", port: 0 });
        origin = `http://127.0.0.1:${server.port}`;
    });
    afterAll(async () => {
        await server.stop();
    });
    test("liveness is not readiness", async () => {
        expect(await status(fetch(`${origin}/health/live`))).toBe(200);
        expect(await status(fetch(`${origin}/health/ready`))).toBe(503);
    });
    test("no protocol or login request is admitted without configuration", async () => {
        for (const path of [
            "/",
            "/sign-in",
            "/authorize",
            "/token",
            "/userinfo",
            "/jwks",
            "/introspect",
            "/revoke",
            "/.well-known/openid-configuration",
            "/api/authz/forward-auth",
            "/api/login",
        ]) {
            for (const method of ["GET", "POST", "HEAD"]) {
                const response = await fetch(`${origin}${path}`, { method });
                expect(response.status).toBe(503);
                expect(response.headers.get("Set-Cookie")).toBeNull();
            }
        }
    });
});

async function status(promise: Promise<Response>): Promise<number> {
    const response = await promise;
    return response.status;
}
