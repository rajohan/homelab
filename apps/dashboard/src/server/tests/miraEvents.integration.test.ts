import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { reconcileMiraControls } from "@homelab/mira/data/automations";
import { recordMiraEvent } from "@homelab/mira/data/events";
import { scheduleMiraRuns } from "@homelab/mira/data/queue";

import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

test("due-task events dispatch once, retain busy deliveries and do not replay after a pause", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const automation = await api.automations.create({
            title: "Due task",
            prompt: "Review the due task",
            kind: "custom",
            schedule: { kind: "event", event: "task_due" },
            budgetSeconds: 60,
        });
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            enabled: true,
            version: 1,
            reason: null,
            until: null,
        });
        const task = {
            title: "Due",
            description: "Synthetic",
            status: "todo" as const,
            assignee: "mira" as const,
            priority: "normal" as const,
            labels: [],
            dueAt: new Date(Date.now() - 60_000).toISOString(),
            completionCriteria: "Review",
            conversationId: null,
        };
        const first = await api.tasks.create(task);
        const second = await api.tasks.create({ ...task, title: "Also due" });
        expect(await scheduleMiraRuns(fixture.client)).toBe(1);
        expect(await scheduleMiraRuns(fixture.client)).toBe(0);
        const runs = await api.runs.list({ search: "", archived: false });
        expect(runs.rows).toHaveLength(1);
        expect([first.id, second.id]).toContain(runs.rows[0]?.taskId ?? "");
        const pending = await fixture.client<
            { state: string }[]
        >`SELECT state FROM mira_event_deliveries ORDER BY state`;
        expect(pending.map((row) => row.state)).toEqual(["dispatched", "pending"]);
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            enabled: false,
            version: 2,
            reason: "Intentional pause",
            until: null,
        });
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            enabled: true,
            version: 3,
            reason: null,
            until: null,
        });
        expect(
            await scheduleMiraRuns(fixture.client, new Date(Date.now() + 120_000))
        ).toBe(0);
        const after = await api.runs.list({ search: "", archived: false });
        expect(after.rows).toHaveLength(1);
        expect(after.rows[0]?.state).toBe("interrupted");
    } finally {
        await fixture.close();
    }
});

test("verified AgentMail events deduplicate and cannot bypass integration disable with Run now", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const automation = await api.automations.create({
            title: "Mail review",
            prompt: "Read verified mail",
            kind: "custom",
            schedule: { kind: "event", event: "agentmail" },
            budgetSeconds: 60,
        });
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            enabled: true,
            version: 1,
            reason: null,
            until: null,
        });
        await rejects(
            api.automations.run({ id: automation.id, requestId: crypto.randomUUID() }),
            /integration is disabled/
        );
        const event = {
            owner: "operator",
            kind: "agentmail" as const,
            key: "message-1",
            reference: "inbox/message-1",
        };
        expect(await fixture.client.begin((query) => recordMiraEvent(query, event))).toBe(
            true
        );
        await api.controls.setEnabled({
            key: "integration:agentmail",
            enabled: true,
            version: 1,
            reason: null,
            until: null,
        });
        expect(await fixture.client.begin((query) => recordMiraEvent(query, event))).toBe(
            false
        );
        expect(await scheduleMiraRuns(fixture.client)).toBe(0);
        await fixture.client.begin((query) =>
            recordMiraEvent(query, { ...event, key: "message-2" })
        );
        expect(await scheduleMiraRuns(fixture.client)).toBe(1);
        await api.controls.setEnabled({
            key: "integration:agentmail",
            enabled: false,
            version: 2,
            reason: "Maintenance",
            until: null,
        });
        const runs = await api.runs.list({ search: "", archived: false });
        expect(runs.rows[0]?.state).toBe("interrupted");
    } finally {
        await fixture.close();
    }
});

test("expired pauses resume while the provider is offline and incoming events do not miss the timer boundary", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const automation = await api.automations.create({
            title: "Offline mail recovery",
            prompt: "Review verified mail",
            kind: "custom",
            schedule: { kind: "event", event: "agentmail" },
            budgetSeconds: 60,
        });
        const until = new Date(Date.now() + 60_000);
        for (const key of [
            "autonomy",
            "integration:agentmail",
            `automation:${automation.id}`,
        ])
            await api.controls.setEnabled({
                key,
                enabled: false,
                version: 1,
                reason: "Timed maintenance",
                until: until.toISOString(),
            });
        await fixture.client`INSERT INTO mira_runtime_status (id, worker_id, version, ready, heartbeat_at) VALUES (1, ${crypto.randomUUID()}, 'test', false, now())`;
        await fixture.client`UPDATE mira_switches SET until = now() - interval '1 second' WHERE owner = 'operator' AND NOT enabled AND until IS NOT NULL`;
        await reconcileMiraControls(fixture.client);
        const controls = await api.controls.list();
        for (const key of [
            "autonomy",
            "integration:agentmail",
            `automation:${automation.id}`,
        ])
            expect(controls.find((control) => control.key === key)).toMatchObject({
                enabled: true,
                reason: null,
                until: null,
                version: 3,
            });
        const event = {
            owner: "operator",
            kind: "agentmail" as const,
            key: "offline-event",
            reference: "inbox/offline-event",
        };
        await fixture.client.begin((query) => recordMiraEvent(query, event));
        await fixture.client.begin((query) => recordMiraEvent(query, event));
        const runs = await api.runs.list({ search: "", archived: false });
        expect(runs.rows).toHaveLength(0);
        const deliveries = await fixture.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_event_deliveries`;
        expect(deliveries[0]?.count).toBe(1);
        await api.controls.setEnabled({
            key: "integration:agentmail",
            enabled: false,
            version: 3,
            reason: "Another timed pause",
            until: until.toISOString(),
        });
        await fixture.client`UPDATE mira_switches SET until = now() - interval '1 second' WHERE owner = 'operator' AND key = 'integration:agentmail'`;
        await fixture.client.begin((query) =>
            recordMiraEvent(query, { ...event, key: "before-coordinator-tick" })
        );
        const after = await fixture.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_event_deliveries`;
        expect(after[0]?.count).toBe(2);
        const resumed = await api.controls.list();
        expect(
            resumed.find((control) => control.key === "integration:agentmail")
        ).toMatchObject({ enabled: true, until: null, version: 5 });
    } finally {
        await fixture.close();
    }
});

test("due task capture does not reverse the control-to-automation lock order", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let control: Promise<void> | undefined;
    let scheduled: Promise<number> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        for (const schedule of [
            { kind: "event", event: "task_due" } as const,
            { kind: "interval", intervalSeconds: 60 } as const,
        ]) {
            const automation = await api.automations.create({
                title: "Lock ordering",
                prompt: "Review",
                kind: "custom",
                schedule,
                budgetSeconds: 60,
            });
            await api.controls.setEnabled({
                key: `automation:${automation.id}`,
                enabled: true,
                version: 1,
                reason: null,
                until: null,
            });
            if (schedule.kind === "interval")
                await fixture.client`UPDATE mira_automations SET next_run_at = now() - interval '1 second' WHERE id = ${automation.id}`;
        }
        await api.tasks.create({
            title: "Due during control change",
            description: "Synthetic",
            status: "todo",
            assignee: "mira",
            priority: "normal",
            labels: [],
            dueAt: new Date(Date.now() - 1000).toISOString(),
            completionCriteria: "Review",
            conversationId: null,
        });
        control = fixture.client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:controls:operator', 0))`;
            held.resolve();
            await release.promise;
            await query`UPDATE mira_automations SET prompt = prompt WHERE owner = 'operator'`;
        });
        await held.promise;
        scheduled = scheduleMiraRuns(fixture.client);
        const result = await Promise.race([
            scheduled,
            new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(
                    () =>
                        reject(
                            new Error(
                                "Scheduler waited for the control lock after locking automation rows."
                            )
                        ),
                    2000
                );
            }),
        ]);
        expect(result).toBe(2);
    } finally {
        clearTimeout(deadline);
        release.resolve();
        await Promise.allSettled([control, scheduled]);
        await fixture.close();
    }
});
