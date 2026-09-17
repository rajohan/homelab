import { expect, test } from "bun:test";

import { createWorkerState, startWorkerHealth } from "../../worker/health";
import { createAutomation } from "../automation/service";
import { startDashboardServer } from "../index";
import { collectMetrics } from "../integrations/metrics/collector";
import { operationFixture, expectOperationFailure } from "../testing/operations";

test("worker health distinguishes startup, live coordination, stale heartbeat and drain", async () => {
    const state = createWorkerState();
    const server = startWorkerHealth(state, { hostname: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${server.port}`;
    const status = async (path: string) => {
        const response = await fetch(url + path);
        return response.status;
    };
    try {
        expect(await status("/health/ready")).toBe(503);
        expect(await status("/health/live")).toBe(200);
        state.heartbeatAt = Date.now();
        expect(await status("/health/ready")).toBe(200);
        state.active = 2;
        const metrics = await fetch(url + "/metrics");
        expect(await metrics.text()).toContain("homelab_worker_active_jobs 2");
        state.paused = true;
        state.schedules = [
            { action: "system.retention", enabled: false, overdue: false },
        ];
        expect(await status("/health/ready")).toBe(200);
        const pausedMetrics = await fetch(url + "/metrics");
        const pausedText = await pausedMetrics.text();
        expect(pausedText).toContain("homelab_worker_paused 1");
        expect(pausedText).toContain(
            'homelab_schedule_enabled{action="system.retention"} 0'
        );
        expect(pausedText).toContain(
            'homelab_schedule_overdue{action="system.retention"} 0'
        );
        state.heartbeatAt -= 31_000;
        expect(await status("/health/ready")).toBe(503);
        state.heartbeatAt = Date.now();
        state.draining = true;
        expect(await status("/health/ready")).toBe(503);
    } finally {
        await server.stop(true);
    }
});

test("metrics collector bounds responses, refuses redirects and distinguishes absent data", async () => {
    let mode = "normal";
    const requests: string[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            expect(request.headers.get("authorization")).toBe("Bearer test-read-only");
            const expression = new URL(request.url).searchParams.get("query") ?? "";
            requests.push(expression);
            if (mode === "redirect")
                return new Response(null, {
                    status: 302,
                    headers: { Location: "/redirected" },
                });
            if (mode === "large") return new Response(" ".repeat(65_537));
            const count = expression === "count(up)" ? "3" : "2";
            const missing = mode === "missing" || expression.startsWith("sum(ALERTS");
            return Response.json({
                status: "success",
                data: {
                    resultType: "vector",
                    result: missing ? [] : [{ value: [1, count] }],
                },
            });
        },
    });
    const configuration = {
        url: `http://127.0.0.1:${server.port}`,
        token: "test-read-only",
    };
    try {
        const snapshot = await collectMetrics(configuration, AbortSignal.timeout(1000));
        expect(snapshot).toMatchObject({
            reachableTargets: 2,
            totalTargets: 3,
            firingAlerts: null,
        });
        expect(requests).toHaveLength(3);
        mode = "large";
        await expectOperationFailure(
            collectMetrics(configuration, AbortSignal.timeout(1000)),
            "budget"
        );
        mode = "missing";
        await expectOperationFailure(
            collectMetrics(configuration, AbortSignal.timeout(1000)),
            "No monitoring targets"
        );
        mode = "redirect";
        await expectOperationFailure(
            collectMetrics(configuration, AbortSignal.timeout(1000)),
            ""
        );
        expect(requests).not.toContain("");
    } finally {
        await server.stop(true);
    }
});

test("machine HTTP boundary rejects cookies and origins, requires live grants and keeps auth separate", async () => {
    const fixture = await operationFixture();
    const server = startDashboardServer({
        hostname: "127.0.0.1",
        port: 0,
        development: false,
        authentication: null,
        operations: {
            databaseUrl: fixture.url,
            metricsUrl: undefined,
            metricsToken: undefined,
            concurrency: 1,
            retentionDays: 30,
        },
    });
    const url = `http://127.0.0.1:${server.port}`;
    try {
        const account = await createAutomation(fixture.client, "human:test", {
            label: "HTTP client",
            capabilities: ["jobs:read"],
            expiresAt: null,
        });
        const headers = { Authorization: `Bearer ${account.token}` };
        const input = encodeURIComponent(JSON.stringify({ json: {} }));
        const path = `/api/automation/jobs.list?input=${input}`;
        const accepted = await fetch(url + path, { headers });
        expect(accepted.status).toBe(200);
        expect(accepted.headers.get("cache-control")).toBe("no-store");
        const cookie = await fetch(url + path, {
            headers: { ...headers, Cookie: "anything=1" },
        });
        expect(cookie.status).toBe(403);
        const origin = await fetch(url + path, { headers: { ...headers, Origin: url } });
        expect(origin.status).toBe(403);
        const anonymous = await fetch(url + path);
        expect(anonymous.status).toBe(401);
        const escalation = await fetch(
            url + "/api/automation/automation.list?input=" + input,
            { headers }
        );
        expect(escalation.status).toBe(403);
        await fixture.client`UPDATE automation_credentials SET revoked_at = now()`;
        const revoked = await fetch(url + path, { headers });
        expect(revoked.status).toBe(401);
        // Configured operations do not make an unconfigured identity server ready.
        const ready = await fetch(url + "/health/ready");
        expect(ready.status).toBe(503);
    } finally {
        await server.stop(true);
        await fixture.close();
    }
});
