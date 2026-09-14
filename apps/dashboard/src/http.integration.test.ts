import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { startDashboardServer } from "./server";
describe("dashboard HTTP boundary without identity configuration", () => {
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
    afterAll(async () => {
        await server.stop(true);
    });
    test("reports liveness but not readiness", async () => {
        const live = await fetch(`${origin}/health/live`);
        const ready = await fetch(`${origin}/health/ready`);
        expect(live.status).toBe(200);
        expect(ready.status).toBe(503);
    });
    test("does not expose the private API without configured identity", async () => {
        const response = await fetch(`${origin}/api/trpc/system.status`);
        expect(response.status).toBe(503);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
    });
    test("unknown APIs never fall back to HTML", async () => {
        const response = await fetch(`${origin}/api/missing`);
        expect(response.headers.get("Content-Type")).toContain("application/json");
    });
});
