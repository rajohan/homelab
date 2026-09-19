import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { runWorker } from "../../worker/runtime";
import { appRouter } from "../api/router";
import { claimJob, commitClaim, renewClaim, settleClaim } from "../jobs/claims";
import { maintenanceJob } from "../jobs/maintenance";
import { reportJobProgress } from "../jobs/progress";
import { enqueueJob, listJobs, lockQueue, scheduleDueJobs } from "../jobs/queue";
import { expectOperationFailure, operationFixture } from "../testing/operations";

test("global activity includes only the caller's active and recent jobs, including long-running work", async () => {
    const fixture = await operationFixture();
    try {
        const definition = maintenanceJob(30).definition;
        const ids = await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            const own = await enqueueJob(
                transaction,
                definition,
                "human:operator",
                "own"
            );
            const completed = await enqueueJob(
                transaction,
                definition,
                "human:operator",
                "completed"
            );
            const old = await enqueueJob(
                transaction,
                definition,
                "human:operator",
                "old"
            );
            await enqueueJob(transaction, definition, "human:someone-else", "other");
            await enqueueJob(transaction, definition, "system:scheduler", "scheduled");
            await enqueueJob(transaction, definition, "automation:operator", "machine");
            return { own, completed, old };
        });
        await fixture.client`UPDATE job_runs SET created_at=now()-interval '1 day' WHERE id=${ids.own}`;
        await fixture.client`UPDATE job_runs SET state='succeeded', finished_at=now() WHERE id=${ids.completed}`;
        await fixture.client`UPDATE job_runs SET state='failed', finished_at=now()-interval '16 minutes' WHERE id=${ids.old}`;
        const caller = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "operator", capabilities },
        });
        const activity = await caller.jobs.activity();
        expect(activity.runs.map((run) => run.id)).toEqual([ids.own, ids.completed]);
        await expectOperationFailure(
            appRouter
                .createCaller({
                    operations: fixture,
                    principal: { kind: "human", id: "operator", capabilities: [] },
                })
                .jobs.activity(),
            "permission"
        );
    } finally {
        await fixture.close();
    }
});

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

test("activity limits by database completion time, not creation order or worker clock", async () => {
    const fixture = await operationFixture();
    try {
        const ids = await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            const runs: string[] = [];
            for (let index = 0; index < 8; index += 1)
                runs.push(
                    await enqueueJob(
                        transaction,
                        maintenanceJob(30).definition,
                        "human:operator",
                        `completion-${index}`
                    )
                );
            return runs;
        });
        const longRun = ids[0];
        if (!longRun) throw new Error("Missing long-running fixture");
        await fixture.client`UPDATE job_runs SET state='succeeded', finished_at=now()-interval '5 minutes'`;
        await fixture.client`UPDATE job_runs SET created_at=now()-interval '1 day', finished_at=now() WHERE id=${longRun}`;
        // The newest-created job is outside the completion window and must not consume a slot.
        await fixture.client`UPDATE job_runs SET finished_at=now()-interval '16 minutes' WHERE id=${ids.at(-1)}`;
        const caller = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "operator", capabilities },
        });
        const activity = await caller.jobs.activity();
        expect(activity.runs.map((run) => run.id)).toEqual([
            longRun,
            ...ids.slice(1, -1).toReversed().slice(0, 4),
        ]);
        // Ordinary history retains its creation-order cursor contract.
        const history = await caller.jobs.list({ limit: 2 });
        expect(history.runs.map((run) => run.id)).toEqual(ids.slice(-2).toReversed());
        await expectOperationFailure(
            listJobs(fixture.client, 5, longRun, { completedWithinSeconds: 900 }),
            "cursors"
        );
    } finally {
        await fixture.close();
    }
});

test.each(["failed", "timed_out", "cancelled"] as const)(
    "retained %s run details recover only the final event's missing explanation",
    async (state) => {
        const fixture = await operationFixture();
        try {
            const run = await fixture.client.begin(async (transaction) => {
                await lockQueue(transaction);
                return enqueueJob(
                    transaction,
                    maintenanceJob(30).definition,
                    "human:operator",
                    `retained-${state}`
                );
            });
            const earlier = Bun.randomUUIDv7(),
                final = Bun.randomUUIDv7();
            const message = "Execution exceeded its time limit.";
            await fixture.client`UPDATE job_runs SET state=${state}, finished_at=now(), message=${message} WHERE id=${run}`;
            await fixture.client`INSERT INTO operation_audit(id,actor,action,target,created_at) VALUES (${earlier},'system:worker',${`jobs.${state}`},${run},now()-interval '1 hour'), (${final},'system:worker',${`jobs.${state}`},${run},now())`;
            const caller = appRouter.createCaller({
                operations: fixture,
                principal: { kind: "human", id: "operator", capabilities },
            });
            const latest = await caller.jobs.detail({ id: run, limit: 1 });
            expect(latest.events[0]).toMatchObject({ id: final, message });
            const older = await caller.jobs.detail({ id: run, limit: 1, before: final });
            expect(older.events[0]).toMatchObject({ id: earlier, message: null });
            await fixture.client`UPDATE operation_audit SET message='Recorded outcome.' WHERE id=${final}`;
            const recorded = await caller.jobs.detail({ id: run, limit: 1 });
            expect(recorded.events[0]?.message).toBe("Recorded outcome.");
        } finally {
            await fixture.close();
        }
    }
);

test("progress is bounded, deduplicated and fenced by the live uncancelled claim", async () => {
    const fixture = await operationFixture();
    try {
        const definition = maintenanceJob(30).definition;
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            await enqueueJob(transaction, definition, "test", "progress");
        });
        const run = await claimJob(fixture.client, Bun.randomUUIDv7(), [definition.key]);
        if (!run) throw new Error("Missing progress claim");
        await reportJobProgress(fixture.client, run, "Reading source data.");
        await reportJobProgress(fixture.client, run, "Reading source data.");
        expect(
            await fixture.client`SELECT id FROM operation_audit WHERE action='jobs.progress'`
        ).toHaveLength(1);
        for (const message of ["", "x".repeat(501), "raw\noutput"])
            await expectOperationFailure(
                reportJobProgress(fixture.client, run, message),
                "Invalid"
            );
        await expectOperationFailure(
            reportJobProgress(
                fixture.client,
                { ...run, lease_token: Bun.randomUUIDv7() },
                "Stale write"
            ),
            "ownership changed"
        );
        await fixture.client`INSERT INTO operation_audit(id,actor,action,target,message,created_at) SELECT gen_random_uuid(),'system:worker','jobs.progress',${run.id},'Earlier step',now() FROM generate_series(1,999)`;
        await reportJobProgress(fixture.client, run, "Final step after the history cap.");
        expect(
            await fixture.client`SELECT id FROM operation_audit WHERE action='jobs.progress'`
        ).toHaveLength(1000);
        const current = await listJobs(fixture.client, 1, undefined);
        expect(current[0]?.message).toBe("Final step after the history cap.");
        await fixture.client`UPDATE job_runs SET cancel_requested=true WHERE id=${run.id}`;
        await expectOperationFailure(
            reportJobProgress(fixture.client, run, "Cancelled write"),
            "ownership changed"
        );
        await settleClaim(fixture.client, run, "interrupted");
        const [event] = await fixture.client<
            { message: string }[]
        >`SELECT message FROM operation_audit WHERE target=${run.id} AND action='jobs.cancelled'`;
        expect(event?.message).toBe("Execution was interrupted.");
        await expectOperationFailure(
            reportJobProgress(fixture.client, run, "Settled write"),
            "ownership changed"
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
        execute: async (
            _payload: unknown,
            context: Parameters<ReturnType<typeof maintenanceJob>["execute"]>[1]
        ) => {
            await context.reportProgress("Processing a generic worker task.");
            completed = true;
            controller.abort();
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
        expect(
            await fixture.client<
                { message: string }[]
            >`SELECT message FROM operation_audit WHERE action='jobs.progress'`
        ).toEqual([{ message: "Processing a generic worker task." }]);
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
