import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { createWorkerState } from "../../worker/health";
import { runWorker } from "../../worker/runtime";
import { appRouter } from "../api/router";
import { claimJob, settleClaim } from "../jobs/claims";
import { maintenanceJob } from "../jobs/maintenance";
import { enqueueJob, listJobs, lockQueue } from "../jobs/queue";
import { createJobRegistry } from "../jobs/registry";
import type { JobHandler } from "../jobs/types";
import { operationFixture } from "../testing/operations";

test("real worker deadlines produce a distinct terminal result and statistics", async () => {
    const fixture = await operationFixture();
    const lifecycle = new AbortController();
    const state = createWorkerState();
    const handler: JobHandler = {
        definition: {
            ...maintenanceJob(30).definition,
            key: "test.timeout",
            intervalSeconds: null,
            timeoutMs: 1000,
            attemptLimit: 1,
        },
        execute: (_payload, { signal }) =>
            new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener("abort", () => resolve(), { once: true });
            }),
    };
    let worker: Promise<void> | undefined;
    try {
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            await enqueueJob(transaction, handler.definition, "human:test", "timeout");
        });
        worker = runWorker({
            client: fixture.client,
            registry: createJobRegistry([handler]),
            concurrency: 1,
            signal: lifecycle.signal,
            version: "test",
            state,
        });
        const until = Date.now() + 4000;
        while (state.completed.timed_out === 0 && Date.now() < until)
            await new Promise((resolve) => setTimeout(resolve, 25));
        lifecycle.abort();
        await worker;
        expect(state.completed.timed_out).toBe(1);
        expect(state.completed.interrupted).toBe(0);
        expect(state.completed.failed).toBe(0);
        const [run] = await listJobs(fixture.client, 10, undefined);
        expect(run?.state).toBe("timed_out");
        const caller = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "test", capabilities },
        });
        const overview = await caller.worker.overview();
        expect(overview.counts).toContainEqual({ state: "timed_out", count: 1 });
    } finally {
        lifecycle.abort();
        await worker;
        await fixture.close();
    }
});

test("timeout retries remain queued and explicit cancellation still takes precedence", async () => {
    const fixture = await operationFixture();
    const definition = {
        ...maintenanceJob(30).definition,
        attemptLimit: 2,
        retrySafe: true,
    };
    try {
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            await enqueueJob(transaction, definition, "human:test", "retry");
        });
        const first = await claimJob(fixture.client, await fixture.registerWorker(), [
            definition.key,
        ]);
        if (!first) throw new Error("Missing first claim");
        await settleClaim(fixture.client, first, "timed_out");
        const queued = await listJobs(fixture.client, 10, undefined);
        expect(queued[0]?.state).toBe("queued");
        await fixture.client`UPDATE job_runs SET available_at = now() WHERE id = ${first.id}`;
        const second = await claimJob(fixture.client, await fixture.registerWorker(), [
            definition.key,
        ]);
        if (!second) throw new Error("Missing retry claim");
        await fixture.client`UPDATE job_runs SET cancel_requested = true WHERE id = ${second.id}`;
        await settleClaim(fixture.client, second, "timed_out");
        const cancelled = await listJobs(fixture.client, 10, undefined);
        expect(cancelled[0]?.state).toBe("cancelled");
    } finally {
        await fixture.close();
    }
});
