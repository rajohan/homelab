import type { SQL } from "bun";

import { claimJob, commitClaim, renewClaim, settleClaim } from "../server/jobs/claims";
import { readWorkerControl } from "../server/jobs/control";
import { reportJobProgress } from "../server/jobs/progress";
import { listSchedules, scheduleDueJobs } from "../server/jobs/queue";
import type { ClaimedJob, JobHandler } from "../server/jobs/types";
import { createWorkerState, type WorkerState } from "./health";

/**
 * Wait without delaying shutdown when the process receives cancellation.
 * @param milliseconds - Maximum wait duration.
 * @param signal - Lifecycle signal.
 * @returns Completion on timer expiry or cancellation.
 */
export async function waitForWork(
    milliseconds: number,
    signal: AbortSignal
): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, milliseconds);
        signal.addEventListener("abort", done, { once: true });
    });
}

async function execute(
    client: SQL,
    run: ClaimedJob,
    handler: JobHandler,
    signal: AbortSignal,
    state: WorkerState
): Promise<void> {
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(run.timeout_ms);
    const executionSignal = AbortSignal.any([signal, controller.signal, deadline]);
    let outcome: Parameters<typeof settleClaim>[2] = "failed";
    const renew = async () => {
        while (!executionSignal.aborted) {
            await waitForWork(5000, executionSignal);
            if (executionSignal.aborted) return;
            if (!(await renewClaim(client, run))) {
                controller.abort();
                return;
            }
        }
    };
    const monitor = renew().catch(() => {
        controller.abort();
    });
    try {
        const payload = handler.definition.validate(run.payload);
        await handler.execute(payload, {
            signal: executionSignal,
            runId: run.id,
            leaseToken: run.lease_token,
            reportProgress: async (message) => {
                executionSignal.throwIfAborted();
                await reportJobProgress(client, run, message);
            },
            commit: (write) =>
                executionSignal.aborted
                    ? Promise.resolve(false)
                    : commitClaim(client, run, write),
        });
        outcome = "succeeded";
    } catch {
        outcome = "failed";
    } finally {
        if (executionSignal.aborted)
            outcome =
                deadline.aborted && executionSignal.reason === deadline.reason
                    ? "timed_out"
                    : "interrupted";
        controller.abort();
        await monitor;
    }
    await settleClaim(client, run, outcome);
    state.completed[outcome] += 1;
    process.stdout.write(
        JSON.stringify({
            service: "dashboard-worker",
            event: "job_finished",
            runId: run.id,
            action: run.action,
            outcome,
        }) + "\n"
    );
}

/**
 * Run concurrent job lanes plus scheduling/heartbeat until orderly process shutdown.
 * @param options - Process-owned database, registry, concurrency and lifecycle signal.
 * @returns Completion only after active handlers settle and the worker is marked draining.
 */
export async function runWorker(options: {
    client: SQL;
    registry: ReadonlyMap<string, JobHandler>;
    concurrency: number;
    signal: AbortSignal;
    version: string;
    state?: WorkerState;
}): Promise<void> {
    const { client, registry, concurrency } = options;
    const lifecycle = new AbortController();
    const signal = AbortSignal.any([options.signal, lifecycle.signal]);
    const id = Bun.randomUUIDv7();
    const state = options.state ?? createWorkerState();
    await client`INSERT INTO workers (id, version, heartbeat_at, capacity) VALUES (${id}, ${options.version}, now(), ${concurrency})`;
    const lane = async () => {
        while (!signal.aborted) {
            const run = await claimJob(client, id, [...registry.keys()]);
            if (!run) {
                await waitForWork(500, signal);
                continue;
            }
            const handler = registry.get(run.action);
            if (handler) {
                state.active += 1;
                try {
                    await execute(client, run, handler, signal, state);
                } finally {
                    state.active -= 1;
                }
            }
        }
    };
    const control = async () => {
        while (!signal.aborted) {
            await client`UPDATE workers SET heartbeat_at = now() WHERE id = ${id}`;
            await scheduleDueJobs(client, registry);
            const controlState = await readWorkerControl(client);
            const schedules = await listSchedules(client, registry);
            state.paused = controlState.paused;
            state.schedules = schedules.map((schedule) => ({
                action: schedule.action,
                enabled: schedule.enabled,
                overdue:
                    !state.paused &&
                    schedule.enabled &&
                    !schedule.activeRun &&
                    Date.parse(schedule.nextRunAt) < Date.now() - 60_000,
            }));
            state.heartbeatAt = Date.now();
            await waitForWork(5000, signal);
        }
    };
    const tasks = [control(), ...Array.from({ length: concurrency }, lane)].map((task) =>
        task.catch((error: unknown) => {
            lifecycle.abort();
            throw error;
        })
    );
    try {
        const results = await Promise.allSettled(tasks);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected")
            throw new Error("Worker coordination failed", { cause: failed.reason });
    } finally {
        lifecycle.abort();
        state.draining = true;
        await client`UPDATE workers SET draining = true, heartbeat_at = now() WHERE id = ${id}`;
    }
}
