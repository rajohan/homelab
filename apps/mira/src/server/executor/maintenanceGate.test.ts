import { expect, test } from "bun:test";

import { MaintenanceGate } from "./maintenanceGate";

test("deployment admission waits for initialization and freezes new work before acknowledging drain", async () => {
    const gate = new MaintenanceGate();
    let calls = 0;
    const operation = () => Promise.resolve(++calls);
    expect(await gate.run(operation)).toBeUndefined();
    expect(gate.drained).toBeNull();
    gate.update(null);
    expect(await gate.run(operation)).toBe(1);
    const completion = Promise.withResolvers<number>();
    const running = gate.run(() => completion.promise);
    gate.update("first-deployment");
    expect(gate.drained).toBeNull();
    expect(await gate.run(operation)).toBeUndefined();
    gate.update("second-deployment");
    completion.resolve(42);
    expect(await running).toBe(42);
    expect(gate.drained).toBe("second-deployment");
    expect(calls).toBe(1);
    gate.update(null);
    expect(gate.drained).toBeNull();
    expect(await gate.run(operation)).toBe(2);
});

test("a deployment drain waits for all operations and includes awaited error cleanup", async () => {
    const gate = new MaintenanceGate();
    gate.update(null);
    const first = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const running = gate.run(() => first.promise);
    const failure = new Error("Synthetic bounded failure");
    const failed = gate
        .run(async () => {
            try {
                throw failure;
            } finally {
                await cleanup.promise;
            }
        })
        .catch((error: unknown) => error);
    gate.update("deployment");
    first.resolve();
    await running;
    expect(gate.drained).toBeNull();
    cleanup.resolve();
    expect(await failed).toBe(failure);
    expect(gate.drained).toBe("deployment");
});
