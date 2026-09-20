import { expect, test } from "bun:test";

import {
    capabilities,
    type Capability,
    type ResourceClass,
} from "@homelab/contracts/operations";

import { appRouter } from "../api/router";
import { claimJob, renewClaim, settleClaim } from "../jobs/claims";
import { readWorkerControl, setWorkerControl } from "../jobs/control";
import { enqueueJob, listJobs, lockQueue, scheduleDueJobs } from "../jobs/queue";
import { expectOperationFailure, operationFixture } from "../testing/operations";

test("durable pause blocks claims and scheduled submissions but lets current work finish", async () => {
    const fixture = await operationFixture();
    try {
        await scheduleDueJobs(fixture.client, fixture.registry);
        const run = await claimJob(fixture.client, await fixture.registerWorker(), [
            ...fixture.registry.keys(),
        ]);
        if (!run) throw new Error("Missing running job");
        await setWorkerControl(fixture.client, "human:test", {
            version: 1,
            paused: true,
        });
        expect(await readWorkerControl(fixture.client)).toMatchObject({
            paused: true,
            version: 2,
            updatedBy: "human:test",
        });
        expect(await renewClaim(fixture.client, run)).toBe(true);
        await settleClaim(fixture.client, run, "succeeded");
        await fixture.client`UPDATE job_schedules SET next_run_at = now() - interval '1 day'`;
        await scheduleDueJobs(fixture.client, fixture.registry);
        expect(await listJobs(fixture.client, 30, undefined)).toHaveLength(1);
        expect(
            await claimJob(fixture.client, await fixture.registerWorker(), [
                ...fixture.registry.keys(),
            ])
        ).toBeUndefined();
        await expectOperationFailure(
            setWorkerControl(fixture.client, "human:test", { version: 1, paused: false }),
            "changed"
        );
        await setWorkerControl(fixture.client, "human:test", {
            version: 2,
            paused: false,
        });
        await scheduleDueJobs(fixture.client, fixture.registry);
        expect(await listJobs(fixture.client, 30, undefined)).toHaveLength(2);
        expect(
            await claimJob(fixture.client, await fixture.registerWorker(), [
                ...fixture.registry.keys(),
            ])
        ).toBeDefined();
    } finally {
        await fixture.close();
    }
});

test("disable intent is required, retained on cadence changes and automatically expires", async () => {
    const fixture = await operationFixture();
    const caller = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "test", capabilities },
    });
    try {
        await scheduleDueJobs(fixture.client, fixture.registry);
        const [schedule] = await caller.schedules.list();
        if (!schedule) throw new Error("Missing schedule");
        await expectOperationFailure(
            caller.schedules.setEnabled({
                id: schedule.id,
                version: 1,
                enabled: false,
                reason: null,
                until: null,
            }),
            "reason"
        );
        await caller.schedules.setEnabled({
            id: schedule.id,
            version: 1,
            enabled: false,
            reason: "Planned maintenance",
            until: Date.now() + 60_000,
        });
        await caller.schedules.update({
            id: schedule.id,
            version: 2,
            schedule: { kind: "daily", time: "04:00" },
        });
        const disabled = await caller.schedules.list();
        expect(disabled[0]).toMatchObject({
            enabled: false,
            disableReason: "Planned maintenance",
            version: 3,
            schedule: { kind: "daily", time: "04:00" },
        });
        await fixture.client`UPDATE job_schedules SET disabled_until = now() - interval '1 second'`;
        await scheduleDueJobs(fixture.client, fixture.registry);
        const resumed = await caller.schedules.list();
        expect(resumed[0]).toMatchObject({
            enabled: true,
            disableReason: null,
            disabledUntil: null,
            version: 4,
        });
        await expectOperationFailure(
            caller.schedules.setEnabled({
                id: schedule.id,
                version: 4,
                enabled: false,
                reason: "Maintenance",
                until: Date.now() - 1,
            }),
            "future time"
        );
        await expectOperationFailure(
            caller.schedules.update({
                id: schedule.id,
                version: 4,
                schedule: { kind: "cron", expression: "0 0 31 2 *" },
            }),
            "valid schedule"
        );
        const preview = await caller.schedules.preview({
            kind: "cron",
            expression: "0 4 * * *",
        });
        expect(preview.occurrences).toHaveLength(3);
    } finally {
        await fixture.close();
    }
});

test("permissions separate observation, scheduling, queue control and action-specific execution", async () => {
    const fixture = await operationFixture();
    const caller = (grants: Capability[]) =>
        appRouter.createCaller({
            operations: fixture,
            principal: { kind: "automation", id: "machine", capabilities: grants },
        });
    try {
        await scheduleDueJobs(fixture.client, fixture.registry);
        const inventory = await caller(["jobs:read"]).jobs.list({});
        expect(inventory.runs).toHaveLength(1);
        await expectOperationFailure(
            caller(["jobs:read"]).worker.overview(),
            "permission"
        );
        await expectOperationFailure(
            caller(["worker:read"]).worker.setPaused({ version: 1, paused: true }),
            "permission"
        );
        await caller(["worker:control"]).worker.setPaused({ version: 1, paused: true });
        const paused = await caller(["worker:read"]).worker.overview();
        expect(paused.control.paused).toBe(true);
        const [schedule] = await caller(["schedules:read"]).schedules.list();
        if (!schedule) throw new Error("Missing schedule");
        await expectOperationFailure(
            caller(["schedules:read"]).schedules.update({
                id: schedule.id,
                version: schedule.version,
                schedule: { kind: "daily", time: "05:00" },
            }),
            "permission"
        );
        const request = { action: "system.retention", requestId: Bun.randomUUIDv7() };
        await expectOperationFailure(
            caller(["jobs:run"]).jobs.run(request),
            "permission"
        );
        await expectOperationFailure(
            caller(["operations:maintain"]).jobs.run(request),
            "permission"
        );
        const queued = await caller(["jobs:run", "operations:maintain"]).jobs.run(
            request
        );
        await expectOperationFailure(
            caller(["jobs:run", "operations:maintain"]).jobs.cancel(queued),
            "permission"
        );
        await caller(["jobs:cancel"]).jobs.cancel(queued);
        const detail = await caller(["jobs:read"]).jobs.detail(queued);
        expect(detail.run.state).toBe("cancelled");
        expect(detail.events.map((event) => event.action)).toContain(
            "jobs.cancel_requested"
        );
        expect(detail.run).not.toHaveProperty("payload");
    } finally {
        await fixture.close();
    }
});

test("active and per-job filters are applied before pagination and unrelated history", async () => {
    const fixture = await operationFixture();
    try {
        const definition = [...fixture.registry.values()][0]?.definition;
        if (!definition) throw new Error("Missing job");
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            await enqueueJob(transaction, definition, "test", "active");
            for (let index = 0; index < 35; index += 1) {
                const id = await enqueueJob(
                    transaction,
                    { ...definition, key: "test.other" },
                    "test",
                    `completed-${index}`
                );
                await transaction`UPDATE job_runs SET state = 'succeeded', finished_at = now() WHERE id = ${id}`;
            }
        });
        expect(await listJobs(fixture.client, 30, undefined)).toHaveLength(30);
        expect(
            await listJobs(fixture.client, 30, undefined, { view: "active" })
        ).toHaveLength(1);
        expect(
            await listJobs(fixture.client, 30, undefined, { action: definition.key })
        ).toHaveLength(1);
        const recent = await listJobs(fixture.client, 30, undefined, { view: "recent" });
        expect(recent).toHaveLength(30);
        expect(
            await listJobs(fixture.client, 30, recent.at(-1)?.id, { view: "recent" })
        ).toHaveLength(5);
    } finally {
        await fixture.close();
    }
});

test("work sizes enforce exclusive execution and a single heavy job without blocking light work", async () => {
    const fixture = await operationFixture();
    try {
        const definition = [...fixture.registry.values()][0]?.definition;
        if (!definition) throw new Error("Missing job");
        const enqueue = (key: string, resourceClass: ResourceClass) =>
            fixture.client.begin(async (transaction) => {
                await lockQueue(transaction);
                return enqueueJob(
                    transaction,
                    { ...definition, key, resourceClass, resourceKeys: [key] },
                    "test",
                    key
                );
            });
        await enqueue("test.exclusive", "exclusive");
        await enqueue("test.heavy-one", "host-heavy");
        await enqueue("test.heavy-two", "host-heavy");
        await enqueue("test.light", "light");
        const actions = [
            "test.exclusive",
            "test.heavy-one",
            "test.heavy-two",
            "test.light",
        ];
        const exclusive = await claimJob(
            fixture.client,
            await fixture.registerWorker(),
            actions
        );
        if (!exclusive) throw new Error("Missing exclusive claim");
        expect(exclusive.action).toBe("test.exclusive");
        expect(
            await claimJob(fixture.client, await fixture.registerWorker(), actions)
        ).toBeUndefined();
        await settleClaim(fixture.client, exclusive, "succeeded");
        const heavy = await claimJob(
            fixture.client,
            await fixture.registerWorker(),
            actions
        );
        expect(heavy?.action).toBe("test.heavy-one");
        const light = await claimJob(
            fixture.client,
            await fixture.registerWorker(),
            actions
        );
        expect(light?.action).toBe("test.light");
        expect(
            await claimJob(fixture.client, await fixture.registerWorker(), actions)
        ).toBeUndefined();
        if (!heavy) throw new Error("Missing heavy claim");
        await settleClaim(fixture.client, heavy, "succeeded");
        const next = await claimJob(
            fixture.client,
            await fixture.registerWorker(),
            actions
        );
        expect(next?.action).toBe("test.heavy-two");
    } finally {
        await fixture.close();
    }
});
