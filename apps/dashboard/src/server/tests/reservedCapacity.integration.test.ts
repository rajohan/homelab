import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { runWorker } from "../../worker/runtime";
import { appRouter } from "../api/router";
import { reservedCapacity } from "../jobs/capacity";
import { claimJob, settleClaim } from "../jobs/claims";
import { maintenanceJob } from "../jobs/maintenance";
import { enqueueJob, lockQueue } from "../jobs/queue";
import { createJobRegistry } from "../jobs/registry";
import { operationFixture } from "../testing/operations";

test("a dashboard-started control job runs while two long updates occupy the general slots", async () => {
    const fixture = await operationFixture();
    try {
        const base = maintenanceJob(30);
        const heavy = {
            ...base,
            definition: {
                ...base.definition,
                key: "test.long-update",
                resourceClass: "interactive" as const,
                resourceKeys: [],
                timeoutMs: 1_500_000,
                intervalSeconds: null,
            },
        };
        const control = {
            ...base,
            definition: {
                ...base.definition,
                key: "test.manual-check",
                resourceClass: "network" as const,
                resourceKeys: [],
                intervalSeconds: null,
            },
        };
        const registry = createJobRegistry([heavy, control]);
        const worker = await fixture.registerWorker();
        await fixture.client`UPDATE workers SET reserved_capacity = 1 WHERE id = ${worker}`;
        await fixture.client.begin(async (tx) => {
            await lockQueue(tx);
            for (let index = 0; index < 3; index += 1)
                await enqueueJob(tx, heavy.definition, "human:test", `heavy-${index}`);
        });
        const keys = [...registry.keys()];
        const first = await claimJob(fixture.client, worker, keys);
        const second = await claimJob(fixture.client, worker, keys);
        expect(first?.action).toBe(heavy.definition.key);
        expect(second?.action).toBe(heavy.definition.key);
        expect(await claimJob(fixture.client, worker, keys)).toBeUndefined();
        expect(await claimJob(fixture.client, worker, keys, true)).toBeUndefined();
        const caller = appRouter.createCaller({
            operations: { ...fixture, registry },
            principal: { kind: "human", id: "operator", capabilities },
        });
        const submitted = await caller.jobs.run({
            action: control.definition.key,
            requestId: Bun.randomUUIDv7(),
        });
        const light = await claimJob(fixture.client, worker, keys, true);
        expect(light?.id).toBe(submitted.id);
        const detail = await caller.jobs.detail({ id: submitted.id });
        expect(detail.run.requestedBy).toBe("human:operator");
        expect(await claimJob(fixture.client, worker, keys)).toBeUndefined();
        await settleClaim(fixture.client, first!, "succeeded");
        const next = await claimJob(fixture.client, worker, keys);
        expect(next?.action).toBe(heavy.definition.key);
    } finally {
        await fixture.close();
    }
});

test("reserved capacity preserves pause, shared resource locks and true exclusive work", async () => {
    const fixture = await operationFixture();
    try {
        const base = maintenanceJob(30).definition;
        const worker = await fixture.registerWorker();
        await fixture.client`UPDATE workers SET reserved_capacity = 1 WHERE id = ${worker}`;
        const exclusive = {
            ...base,
            key: "test.exclusive",
            resourceClass: "exclusive" as const,
            resourceKeys: [],
        };
        const control = {
            ...base,
            key: "test.control",
            resourceClass: "light" as const,
            resourceKeys: ["host:demo"],
        };
        await fixture.client.begin(async (tx) => {
            await lockQueue(tx);
            await enqueueJob(tx, exclusive, "test", "exclusive");
            await enqueueJob(tx, control, "human:test", "control");
        });
        const held = await claimJob(fixture.client, worker, [exclusive.key]);
        expect(
            await claimJob(fixture.client, worker, [control.key], true)
        ).toBeUndefined();
        await settleClaim(fixture.client, held!, "succeeded");
        await fixture.client`INSERT INTO worker_control (id, paused) VALUES (1, true) ON CONFLICT (id) DO UPDATE SET paused=true`;
        expect(
            await claimJob(fixture.client, worker, [control.key], true)
        ).toBeUndefined();
        await fixture.client`UPDATE worker_control SET paused=false WHERE id=1`;
        const running = await claimJob(fixture.client, worker, [control.key], true);
        expect(running).toBeDefined();
        await fixture.client.begin(async (tx) => {
            await lockQueue(tx);
            await enqueueJob(tx, control, "human:test", "second-control");
        });
        const another = await fixture.registerWorker();
        expect(
            await claimJob(fixture.client, another, [control.key], true)
        ).toBeUndefined();
        await settleClaim(fixture.client, running!, "succeeded");
        expect(
            await claimJob(fixture.client, another, [control.key], true)
        ).toBeDefined();
        expect(reservedCapacity(1)).toBe(0);
        expect(reservedCapacity(3)).toBe(1);
    } finally {
        await fixture.close();
    }
});

test("the actual three-slot worker starts a human control request while both general lanes are occupied", async () => {
    const fixture = await operationFixture();
    const lifecycle = new AbortController();
    let worker: Promise<void> | undefined;
    try {
        let activeHeavy = 0;
        let controls = 0;
        const base = maintenanceJob(30);
        const heavy = {
            definition: {
                ...base.definition,
                key: "test.busy",
                resourceClass: "interactive" as const,
                resourceKeys: [],
                timeoutMs: 60_000,
                intervalSeconds: null,
            },
            execute: async (
                _input: Record<string, unknown>,
                context: Parameters<typeof base.execute>[1]
            ) => {
                activeHeavy += 1;
                await new Promise<void>((resolve) => {
                    if (context.signal.aborted) resolve();
                    else
                        context.signal.addEventListener("abort", () => resolve(), {
                            once: true,
                        });
                });
            },
        };
        const control = {
            definition: {
                ...base.definition,
                key: "test.user-status",
                resourceClass: "network" as const,
                resourceKeys: [],
                intervalSeconds: null,
            },
            execute: () => {
                controls += 1;
                return Promise.resolve();
            },
        };
        const registry = createJobRegistry([heavy, control]);
        await fixture.client.begin(async (tx) => {
            await lockQueue(tx);
            for (let i = 0; i < 3; i += 1)
                await enqueueJob(tx, heavy.definition, "human:test", `busy-${i}`);
        });
        worker = runWorker({
            client: fixture.client,
            registry,
            concurrency: 3,
            version: "test",
            signal: lifecycle.signal,
        });
        for (let i = 0; i < 100 && activeHeavy < 2; i += 1) await Bun.sleep(20);
        expect(activeHeavy).toBe(2);
        const caller = appRouter.createCaller({
            operations: { ...fixture, registry },
            principal: { kind: "human", id: "operator", capabilities },
        });
        await caller.jobs.run({
            action: control.definition.key,
            requestId: Bun.randomUUIDv7(),
        });
        for (let i = 0; i < 100 && controls < 1; i += 1) await Bun.sleep(20);
        expect(controls).toBe(1);
        expect(activeHeavy).toBe(2);
        const [registration] = await fixture.client<
            { capacity: number; reserved: number }[]
        >`SELECT capacity, reserved_capacity AS reserved FROM workers WHERE version='test'`;
        expect(registration).toEqual({ capacity: 3, reserved: 1 });
    } finally {
        lifecycle.abort();
        await worker;
        await fixture.close();
    }
});
