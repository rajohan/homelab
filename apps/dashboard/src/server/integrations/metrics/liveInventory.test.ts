import { expect, mock, test } from "bun:test";

import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";

import { createInventoryReader } from "./liveInventory";

const inventory: InfrastructureInventory = {
    capturedAt: "2026-01-01T00:00:00.000Z",
    hosts: [],
    filesystems: [],
    networks: [],
    disks: [],
    storage: [],
    applications: [],
    services: [],
    diskHealth: [],
};

test("live readers share concurrent work and refresh after five seconds without a timer", async () => {
    let now = 0;
    const collect = mock(() => Promise.resolve(inventory));
    const read = createInventoryReader(collect, () => now);
    const first = read();
    expect(read()).toBe(first);
    expect(await first).toBe(inventory);
    now = 4999;
    expect(read()).toBe(first);
    expect(collect).toHaveBeenCalledTimes(1);
    now = 5000;
    expect(await read()).toBe(inventory);
    expect(collect).toHaveBeenCalledTimes(2);
    now = 60_000;
    expect(collect).toHaveBeenCalledTimes(2);
});

test("slow live collection cannot overlap even when the cache interval passes", async () => {
    let now = 0;
    const deferred = Promise.withResolvers<InfrastructureInventory>();
    const collect = mock(() => deferred.promise);
    const read = createInventoryReader(collect, () => now);
    const first = read();
    now = 20_000;
    expect(read()).toBe(first);
    deferred.resolve(inventory);
    expect(await first).toBe(inventory);
    expect(collect).toHaveBeenCalledTimes(1);
});

test("failed live collection stays an error, is rate limited and can recover", async () => {
    let now = 0;
    let fail = false;
    const collect = mock(() =>
        fail
            ? Promise.reject(new Error("Metrics unavailable"))
            : Promise.resolve(inventory)
    );
    const read = createInventoryReader(collect, () => now);
    expect(await read()).toBe(inventory);
    now = 5000;
    fail = true;
    expect(await read().catch((error: unknown) => error)).toHaveProperty(
        "message",
        "Metrics unavailable"
    );
    expect(await read().catch((error: unknown) => error)).toHaveProperty(
        "message",
        "Metrics unavailable"
    );
    expect(collect).toHaveBeenCalledTimes(2);
    now = 10_000;
    fail = false;
    expect(await read()).toBe(inventory);
    expect(collect).toHaveBeenCalledTimes(3);
});

test("live collection retains its last successful identity baseline across failed queries", async () => {
    let now = 0;
    let fail = false;
    const baselines: (InfrastructureInventory | undefined)[] = [];
    const read = createInventoryReader(
        (previous) => {
            baselines.push(previous);
            return fail
                ? Promise.reject(new Error("Unavailable"))
                : Promise.resolve(inventory);
        },
        () => now
    );
    await read();
    now = 5000;
    fail = true;
    await read().catch(() => null);
    now = 10_000;
    fail = false;
    await read();
    expect(baselines).toEqual([undefined, inventory, inventory]);
});
