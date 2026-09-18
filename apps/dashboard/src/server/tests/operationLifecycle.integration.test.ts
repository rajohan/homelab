import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { appRouter } from "../api/router";
import { metricsJob } from "../integrations/metrics/job";
import { claimJob, commitClaim } from "../jobs/claims";
import { maintenanceJob } from "../jobs/maintenance";
import { enqueueJob, lockQueue, scheduleDueJobs } from "../jobs/queue";
import { expectOperationFailure, operationFixture } from "../testing/operations";

test("operator routes replay runs safely, edit schedules optimistically and cancel queued work", async () => {
    const fixture = await operationFixture();
    const caller = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    });
    try {
        await scheduleDueJobs(fixture.client, fixture.registry);
        const [schedule] = await caller.schedules.list();
        if (!schedule) throw new Error("Schedule missing");
        await caller.schedules.update({
            id: schedule.id,
            version: schedule.version,
            schedule: { kind: "interval", intervalSeconds: 600 },
        });
        await expectOperationFailure(
            caller.schedules.update({
                id: schedule.id,
                version: schedule.version,
                schedule: { kind: "interval", intervalSeconds: 600 },
            }),
            "schedule changed"
        );
        const request = { action: "system.retention", requestId: Bun.randomUUIDv7() };
        await expectOperationFailure(
            caller.jobs.run({ ...request, payload: { unexpected: true } }),
            "job input is invalid"
        );
        const queued = await caller.jobs.run(request);
        expect(await caller.jobs.run(request)).toEqual(queued);
        await caller.jobs.cancel({ id: queued.id });
        const inventory = await caller.jobs.list({ limit: 1 });
        expect(inventory.runs[0]?.state).toBe("cancelled");
        expect(inventory.nextCursor).toBe(queued.id);
        const overview = await caller.worker.overview();
        expect(overview.control.paused).toBe(false);
        expect(overview.counts).toContainEqual({ state: "cancelled", count: 1 });
        expect(await caller.infrastructure.summary()).toBeNull();
    } finally {
        await fixture.close();
    }
});

test("metrics job commits a real JSON snapshot and stale ownership rejects replacement", async () => {
    const fixture = await operationFixture();
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
            Response.json({
                status: "success",
                data: { resultType: "vector", result: [{ metric: {}, value: [1, "2"] }] },
            }),
    });
    const handler = metricsJob({
        url: `http://127.0.0.1:${server.port}`,
        token: undefined,
    });
    try {
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            await enqueueJob(transaction, handler.definition, "test", "snapshot");
        });
        const run = await claimJob(fixture.client, Bun.randomUUIDv7(), [
            handler.definition.key,
        ]);
        if (!run) throw new Error("Snapshot claim missing");
        const context = {
            runId: run.id,
            leaseToken: run.lease_token,
            signal: AbortSignal.timeout(1000),
            commit: (write: Parameters<typeof commitClaim>[2]) =>
                commitClaim(fixture.client, run, write),
        };
        await handler.execute({}, context);
        const caller = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "test", capabilities },
        });
        expect(await caller.infrastructure.summary()).toMatchObject({
            totalTargets: 2,
            reachableTargets: 2,
            firingAlerts: 2,
        });
        expect(await caller.infrastructure.inventory()).toMatchObject({
            hosts: [],
            applications: [],
            storage: [],
        });
        await fixture.client`UPDATE job_runs SET lease_expires_at = now() - interval '1 second' WHERE id = ${run.id}`;
        await expectOperationFailure(handler.execute({}, context), "ownership changed");
    } finally {
        await server.stop(true);
        await fixture.close();
    }
});

test("retention removes only aged completed history and preserves queued and current work", async () => {
    const fixture = await operationFixture();
    const handler = maintenanceJob(30);
    try {
        const old = await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            return enqueueJob(transaction, handler.definition, "test", "old");
        });
        await fixture.client`UPDATE job_runs SET state = 'succeeded', finished_at = now() - interval '31 days' WHERE id = ${old}`;
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            await enqueueJob(transaction, handler.definition, "test", "current");
            await enqueueJob(transaction, handler.definition, "test", "queued");
        });
        const run = await claimJob(fixture.client, Bun.randomUUIDv7(), [
            handler.definition.key,
        ]);
        if (!run) throw new Error("Maintenance claim missing");
        await handler.execute(
            {},
            {
                runId: run.id,
                leaseToken: run.lease_token,
                signal: AbortSignal.timeout(1000),
                commit: (write) => commitClaim(fixture.client, run, write),
            }
        );
        const remaining = await fixture.client<{ id: string }[]>`SELECT id FROM job_runs`;
        expect(remaining).toHaveLength(2);
        expect(remaining.some((row) => row.id === old)).toBe(false);
        expect(remaining.some((row) => row.id === run.id)).toBe(true);
    } finally {
        await fixture.close();
    }
});
