import { expect, test } from "bun:test";

import { dispatchMiraRuns } from "./dispatch";
import { MaintenanceGate } from "./maintenanceGate";

test("bounded turns start together and shutdown waits for every cleanup", async () => {
    const maintenance = new MaintenanceGate();
    maintenance.update(null);
    const stop = new AbortController();
    const started = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const runs = [1, 2, 3, 4, 5];
    const observed: number[] = [];
    let cleaned = 0;
    let finished = false;
    const pending = dispatchMiraRuns({
        signal: stop.signal,
        maintenance,
        ready: () => true,
        claim: () => Promise.resolve(runs.shift() ?? null),
        execute: async (run, signal) => {
            observed.push(run);
            if (observed.length === 4) started.resolve();
            await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            await cleanup.promise;
            cleaned++;
        },
    }).then(() => {
        finished = true;
        return true;
    });
    try {
        await started.promise;
        expect(observed).toEqual([1, 2, 3, 4]);
        expect(runs).toEqual([5]);
        maintenance.update("deployment");
        stop.abort();
        await Promise.resolve();
        expect(finished).toBe(false);
        expect(maintenance.drained).toBeNull();
    } finally {
        stop.abort();
        cleanup.resolve();
        await pending;
    }
    expect(cleaned).toBe(4);
    expect(maintenance.drained).toBe("deployment");
});

test("a deployment fence blocks new claims without interrupting admitted turns", async () => {
    const maintenance = new MaintenanceGate();
    maintenance.update(null);
    const stop = new AbortController();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let claims = 0;
    let turnSignal: AbortSignal | undefined;
    const pending = dispatchMiraRuns({
        signal: stop.signal,
        maintenance,
        ready: () => true,
        claim: () => Promise.resolve(++claims),
        execute: async (_run, signal) => {
            turnSignal = signal;
            maintenance.update("deployment");
            started.resolve();
            await finish.promise;
        },
    });
    try {
        await started.promise;
        expect(claims).toBe(1);
        expect(turnSignal?.aborted).toBe(false);
        expect(maintenance.drained).toBeNull();
    } finally {
        stop.abort();
        finish.resolve();
        await pending;
    }
    expect(claims).toBe(1);
    expect(maintenance.drained).toBe("deployment");
});

test("a failed turn cancels its siblings and drains cleanup before rejecting", async () => {
    const maintenance = new MaintenanceGate();
    maintenance.update(null);
    const fail = Promise.withResolvers<void>();
    const siblingStarted = Promise.withResolvers<void>();
    const siblingStopped = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const runs = [1, 2];
    const failure = new Error("Synthetic turn failure");
    let cleaned = false;
    let rejected = false;
    const pending = dispatchMiraRuns({
        signal: new AbortController().signal,
        maintenance,
        ready: () => true,
        claim: () => Promise.resolve(runs.shift() ?? null),
        execute: async (run, signal) => {
            if (run === 1) {
                await fail.promise;
                throw failure;
            }
            siblingStarted.resolve();
            await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            siblingStopped.resolve();
            await cleanup.promise;
            cleaned = true;
        },
    }).catch((error: unknown) => {
        rejected = true;
        expect(error).toBe(failure);
    });
    try {
        await siblingStarted.promise;
        fail.resolve();
        await siblingStopped.promise;
        expect(rejected).toBe(false);
        maintenance.update("deployment");
        expect(maintenance.drained).toBeNull();
    } finally {
        fail.resolve();
        cleanup.resolve();
        await pending;
    }
    expect(rejected).toBe(true);
    expect(cleaned).toBe(true);
    expect(maintenance.drained).toBe("deployment");
});

test("another run is claimed only after an occupied slot finishes cleanup", async () => {
    const maintenance = new MaintenanceGate();
    maintenance.update(null);
    const stop = new AbortController();
    const firstFour = Promise.withResolvers<void>();
    const fifth = Promise.withResolvers<void>();
    const cleanup = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
    const runs = [0, 1, 2, 3, 4];
    let claims = 0;
    let active = 0;
    let peak = 0;
    const pending = dispatchMiraRuns({
        signal: stop.signal,
        maintenance,
        ready: () => true,
        claim: () => {
            claims++;
            return Promise.resolve(runs.shift() ?? null);
        },
        execute: async (run) => {
            active++;
            peak = Math.max(peak, active);
            if (run === 3) firstFour.resolve();
            if (run === 4) fifth.resolve();
            await cleanup[run]!.promise;
            active--;
        },
    });
    try {
        await firstFour.promise;
        expect(claims).toBe(4);
        expect(active).toBe(4);
        cleanup[0]!.resolve();
        await fifth.promise;
        expect(claims).toBe(5);
        expect(active).toBe(4);
        expect(peak).toBe(4);
    } finally {
        stop.abort();
        for (const release of cleanup) release.resolve();
        await pending;
    }
    expect(active).toBe(0);
});
