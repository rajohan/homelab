import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import type { AppRouter } from "./api";
import { startDashboardServer } from "./server";

describe("dashboard HTTP service", () => {
    let server: ReturnType<typeof startDashboardServer>;
    let origin: string;

    beforeAll(() => {
        server = startDashboardServer({
            hostname: "127.0.0.1",
            port: 0,
            development: false,
        });
        origin = `http://127.0.0.1:${server.port}`;
    });

    afterAll(() => server.stop(true));

    test("serves both health endpoints", async () => {
        for (const path of ["/health/live", "/health/ready"]) {
            const response = await fetch(`${origin}${path}`);
            expect(response.status).toBe(200);
            expect(response.headers.get("Cache-Control")).toBe("no-store");
            expect(await response.json()).toEqual({
                service: "dashboard",
                phase: "foundation",
                status: "ok",
            });
        }
    });

    test("serves a validated response through the real tRPC HTTP transport", async () => {
        const client = createTRPCClient<AppRouter>({
            links: [httpBatchLink({ url: `${origin}/api/trpc`, transformer: superjson })],
        });
        const status = await client.system.status.query();
        expect(status.name).toBe("Homelab");
        expect(status.phase).toBe("foundation");
        expect(status.authenticationImplemented).toBe(false);
    });

    test("unknown APIs do not fall back to the frontend document", async () => {
        const response = await fetch(`${origin}/api/missing`);
        expect(response.status).toBe(404);
        expect(response.headers.get("Content-Type")).toContain("application/json");
    });
});
