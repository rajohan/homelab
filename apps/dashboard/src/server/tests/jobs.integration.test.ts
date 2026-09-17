import { expect, test } from "bun:test";

import { runWorker } from "../../worker/runtime";
import { claimJob, commitClaim, renewClaim, settleClaim } from "../jobs/claims";
import { maintenanceJob } from "../jobs/maintenance";
import { enqueueJob, listJobs, lockQueue, scheduleDueJobs } from "../jobs/queue";
import { expectOperationFailure, operationFixture } from "../testing/operations";

test("concurrent enqueue replays once and conflicting idempotency is rejected", async () => {
    const fixture = await operationFixture();
    try {
        const definition = maintenanceJob(30).definition;
        const enqueue = () =>
            fixture.client.begin(async (transaction) => {
                await lockQueue(transaction);
                return enqueueJob(transaction, definition, "human:test", "same-request");
            });
        const ids = await Promise.all([enqueue(), enqueue(), enqueue()]);
        expect(new Set(ids).size).toBe(1);
        expect(await listJobs(fixture.client, 30, undefined)).toHaveLength(1);
        await expectOperationFailure(
            fixture.client.begin(async (transaction) => {
                await lockQueue(transaction);
                return enqueueJob(
                    transaction,
                    { ...definition, timeoutMs: 5000 },
                    "human:test",
                    "same-request"
                );
            }),
            "different job"
        );
    } finally {
        await fixture.close();
    }
});

test("resource leases exclude parallel conflicts and stale owners cannot commit", async () => {
    const fixture = await operationFixture();
    try {
        const definition = maintenanceJob(30).definition;
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            await enqueueJob(transaction, definition, "test", "first");
            await enqueueJob(transaction, definition, "test", "second");
        });
        const claims = await Promise.all([
            claimJob(fixture.client, Bun.randomUUIDv7(), [definition.key]),
            claimJob(fixture.client, Bun.randomUUIDv7(), [definition.key]),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const first = claims.find((claim) => claim !== undefined);
        expect(first).toBeDefined();
        if (!first) throw new Error("Expected claim");
        expect(await renewClaim(fixture.client, first)).toBe(true);
        expect(
            await commitClaim(
                fixture.client,
                { ...first, lease_token: Bun.randomUUIDv7() },
                () => Promise.reject(new Error("Must not execute"))
            )
        ).toBe(false);
        await settleClaim(fixture.client, first, "succeeded");
        expect(
            await claimJob(fixture.client, Bun.randomUUIDv7(), [definition.key])
        ).toBeDefined();
        const [row] = await fixture.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM operation_audit`;
        expect(row?.count).toBeGreaterThanOrEqual(4);
    } finally {
        await fixture.close();
    }
});

test("expired ownership recovers safe work but never automatically retries unsafe effects", async () => {
    const fixture = await operationFixture();
    try {
        const safe = maintenanceJob(30).definition;
        const unsafe = {
            ...safe,
            key: "test.unsafe",
            retrySafe: false,
            attemptLimit: 1,
            resourceKeys: ["unsafe"],
        };
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            await enqueueJob(transaction, safe, "test", "safe");
            await enqueueJob(transaction, unsafe, "test", "unsafe");
        });
        const first = await claimJob(fixture.client, Bun.randomUUIDv7(), [safe.key]);
        const second = await claimJob(fixture.client, Bun.randomUUIDv7(), [unsafe.key]);
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        await fixture.client`UPDATE job_runs SET lease_expires_at = now() - interval '1 second' WHERE state = 'running'`;
        await claimJob(fixture.client, Bun.randomUUIDv7(), [safe.key, unsafe.key]);
        const rows = await listJobs(fixture.client, 30, undefined);
        expect(rows.find((row) => row.id === first?.id)?.state).toBe("queued");
        expect(rows.find((row) => row.id === second?.id)?.state).toBe("failed");
    } finally {
        await fixture.close();
    }
});

test("scheduler coalesces missed runs and preserves operator cadence", async () => {
    const fixture = await operationFixture();
    try {
        await Promise.all([
            scheduleDueJobs(fixture.client, fixture.registry),
            scheduleDueJobs(fixture.client, fixture.registry),
        ]);
        expect(await listJobs(fixture.client, 30, undefined)).toHaveLength(1);
        await fixture.client`UPDATE job_schedules SET schedule = '{"kind":"interval","intervalSeconds":600}'::jsonb, next_run_at = now() - interval '2 days'`;
        await scheduleDueJobs(fixture.client, fixture.registry);
        expect(await listJobs(fixture.client, 30, undefined)).toHaveLength(1);
        const [row] = await fixture.client<
            { schedule: { kind: string; intervalSeconds: number }; next: boolean }[]
        >`SELECT schedule, next_run_at > now() AS next FROM job_schedules`;
        expect(row).toEqual({
            schedule: { kind: "interval", intervalSeconds: 600 },
            next: true,
        });
    } finally {
        await fixture.close();
    }
});

test("worker performs real queued work then drains without leaving active claims", async () => {
    const fixture = await operationFixture();
    const controller = new AbortController();
    let completed = false;
    const handler = {
        ...maintenanceJob(30),
        execute: () => {
            completed = true;
            controller.abort();
            return Promise.resolve();
        },
    };
    try {
        await runWorker({
            client: fixture.client,
            registry: new Map([[handler.definition.key, handler]]),
            concurrency: 2,
            signal: controller.signal,
            version: "test",
        });
        expect(completed).toBe(true);
        const runs = await listJobs(fixture.client, 30, undefined);
        expect(runs.some((row) => row.state === "running")).toBe(false);
    } finally {
        controller.abort();
        await fixture.close();
    }
});

test("independent resources claim concurrently and cancellation prevents result commits", async () => {
    const fixture = await operationFixture();
    try {
        const first = maintenanceJob(30).definition;
        const second = { ...first, key: "test.other", resourceKeys: ["other"] };
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            await enqueueJob(transaction, first, "test", "one");
            await enqueueJob(transaction, second, "test", "two");
        });
        const claims = await Promise.all([
            claimJob(fixture.client, Bun.randomUUIDv7(), [first.key, second.key]),
            claimJob(fixture.client, Bun.randomUUIDv7(), [first.key, second.key]),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(2);
        const run = claims[0];
        if (!run) throw new Error("Expected an independent claim");
        await fixture.client`UPDATE job_runs SET cancel_requested = true WHERE id = ${run.id}`;
        expect(await renewClaim(fixture.client, run)).toBe(false);
        expect(
            await commitClaim(fixture.client, run, () =>
                Promise.reject(new Error("Must not commit"))
            )
        ).toBe(false);
        await settleClaim(fixture.client, run, "interrupted");
        const runs = await listJobs(fixture.client, 30, undefined);
        expect(runs.find((item) => item.id === run.id)?.state).toBe("cancelled");
    } finally {
        await fixture.close();
    }
});
