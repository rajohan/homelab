import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { capabilities } from "@homelab/contracts/operations";
import { reconcileMiraControls } from "@homelab/mira/data/automations";
import { recordMiraEvent } from "@homelab/mira/data/events";
import { claimMiraRun, scheduleMiraRuns } from "@homelab/mira/data/queue";

import { appRouter } from "../api/router";
import { provisionTestAgentMail } from "../testing/agentmail";
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
    const binding = await provisionTestAgentMail(fixture.client);
    const api = appRouter.createCaller({
        operations: { ...fixture, agentMailHook: binding },
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
        const request = { id: automation.id, requestId: crypto.randomUUID() };
        const [manual, concurrentRetry] = await Promise.all([
            api.automations.run(request),
            api.automations.run(request),
        ]);
        expect(concurrentRetry).toEqual(manual);
        await api.controls.setEnabled({
            key: "integration:agentmail",
            enabled: false,
            version: 2,
            reason: "Maintenance",
            until: null,
        });
        const runs = await api.runs.list({ search: "", archived: false });
        expect(runs.rows.find((run) => run.id !== manual.id)?.state).toBe("interrupted");
        expect(await api.automations.run(request)).toEqual(manual);
        await rejects(
            api.automations.run({ ...request, requestId: crypto.randomUUID() }),
            /integration is disabled/
        );
        await api.automations.delete({ id: automation.id, version: 1 });
        expect(await api.automations.run(request)).toEqual(manual);
        await rejects(
            api.automations.run({ ...request, requestId: crypto.randomUUID() }),
            /Automation not found/
        );
        await rejects(
            api.automations.run({ ...request, id: crypto.randomUUID() }),
            /another operation/
        );
        const other = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "other-operator", capabilities },
        }).mira;
        await rejects(other.automations.run(request), /Automation not found/);
        const stored = await fixture.client<{ id: string }[]>`
            SELECT id FROM mira_runs WHERE request_key = ${`operator:${request.requestId}`}`;
        expect(stored).toEqual([{ id: manual.id }]);
    } finally {
        await fixture.close();
    }
});

test("expired pauses resume while the provider is offline and incoming events do not miss the timer boundary", async () => {
    const fixture = await operationFixture();
    const binding = await provisionTestAgentMail(fixture.client);
    const api = appRouter.createCaller({
        operations: { ...fixture, agentMailHook: binding },
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
        await api.controls.setEnabled({
            key: "integration:agentmail",
            enabled: true,
            version: 1,
            reason: null,
            until: null,
        });
        for (const key of [
            "autonomy",
            "integration:agentmail",
            `automation:${automation.id}`,
        ])
            await api.controls.setEnabled({
                key,
                enabled: false,
                version: key === "integration:agentmail" ? 2 : 1,
                reason: "Timed maintenance",
                until: until.toISOString(),
            });
        await fixture.client`UPDATE mira_runtime_status SET ready=false`;
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
                version: key === "integration:agentmail" ? 4 : 3,
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
            version: 4,
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
        ).toMatchObject({ enabled: true, until: null, version: 6 });
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

test.each(["complete", "postpone", "delete"] as const)(
    "pending due-task delivery waits for a concurrent %s edit",
    async (action) => {
        const fixture = await operationFixture();
        const api = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "operator", capabilities },
        }).mira;
        const updated = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let editing: Promise<void> | undefined;
        let scheduled: Promise<number> | undefined;
        try {
            const automation = await api.automations.create({
                title: "Concurrent due-task edit",
                prompt: "Review",
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
            const task = await api.tasks.create({
                title: "Previously due",
                description: "Synthetic",
                status: "todo",
                assignee: "mira",
                priority: "normal",
                labels: [],
                dueAt: new Date(Date.now() - 1000).toISOString(),
                completionCriteria: "Review",
                conversationId: null,
            });
            const [record] = await fixture.client<
                { due: string }[]
            >`SELECT due_at::text AS due FROM mira_tasks WHERE id = ${task.id}`;
            await fixture.client.begin((query) =>
                recordMiraEvent(query, {
                    owner: "operator",
                    kind: "task_due",
                    key: `${task.id}:${record!.due}`,
                    reference: task.id,
                    taskId: task.id,
                })
            );
            editing = fixture.client.begin(async (query) => {
                await query`UPDATE mira_tasks SET status = ${action === "complete" ? "done" : "todo"}, due_at = CASE WHEN ${action} = 'postpone' THEN now() + interval '1 day' ELSE due_at END, deleted_at = CASE WHEN ${action} = 'delete' THEN now() ELSE NULL END WHERE id = ${task.id}`;
                updated.resolve();
                await release.promise;
            });
            await updated.promise;
            scheduled = scheduleMiraRuns(fixture.client);
            let blocked = false;
            for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
                const rows = await fixture.client<
                    { count: number }[]
                >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM mira_tasks%'`;
                blocked = (rows[0]?.count ?? 0) > 0;
                if (!blocked) await delay(10);
            }
            expect(blocked).toBe(true);
            release.resolve();
            await editing;
            expect(await scheduled).toBe(0);
            const runs = await api.runs.list({ search: "", archived: false });
            expect(runs.rows).toHaveLength(0);
        } finally {
            release.resolve();
            await Promise.allSettled([editing, scheduled]);
            await fixture.close();
        }
    }
);

test("due-task discovery skips an uncommitted completion instead of capturing its old state", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    const updated = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let editing: Promise<void> | undefined;
    try {
        const automation = await api.automations.create({
            title: "Due-task discovery",
            prompt: "Review",
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
        const task = await api.tasks.create({
            title: "Completing",
            description: "Synthetic",
            status: "todo",
            assignee: "mira",
            priority: "normal",
            labels: [],
            dueAt: new Date(Date.now() - 1000).toISOString(),
            completionCriteria: "Review",
            conversationId: null,
        });
        editing = fixture.client.begin(async (query) => {
            await query`UPDATE mira_tasks SET status = 'done' WHERE id = ${task.id}`;
            updated.resolve();
            await release.promise;
        });
        await updated.promise;
        expect(await scheduleMiraRuns(fixture.client)).toBe(0);
        release.resolve();
        await editing;
        expect(await scheduleMiraRuns(fixture.client)).toBe(0);
    } finally {
        release.resolve();
        await editing;
        await fixture.close();
    }
});

test.each(["complete", "postpone", "delete"] as const)(
    "queued due-task runs reject a task changed by %s before claiming",
    async (action) => {
        const fixture = await operationFixture();
        const api = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "operator", capabilities },
        }).mira;
        try {
            const automation = await api.automations.create({
                title: "Queued due task",
                prompt: "Review",
                kind: "custom",
                schedule: { kind: "event", event: "task_due" },
                budgetSeconds: 60,
            });
            await api.controls.setEnabled({
                key: `automation:${automation.id}`,
                version: 1,
                enabled: true,
                reason: null,
                until: null,
            });
            const task = await api.tasks.create({
                title: "Previously due",
                description: "Synthetic",
                status: "todo",
                assignee: "mira",
                priority: "normal",
                labels: [],
                dueAt: new Date(Date.now() - 1000).toISOString(),
                completionCriteria: "Review",
                conversationId: null,
            });
            expect(await scheduleMiraRuns(fixture.client)).toBe(1);
            await fixture.client`UPDATE mira_tasks SET status=${action === "complete" ? "done" : "todo"}, due_at=CASE WHEN ${action}='postpone' THEN now()+interval '1 day' ELSE due_at END, deleted_at=CASE WHEN ${action}='delete' THEN now() ELSE NULL END WHERE id=${task.id}`;
            expect(
                await claimMiraRun(fixture.client, crypto.randomUUID(), "general")
            ).toBeNull();
            const runs = await api.runs.list({ search: "", archived: false });
            expect(runs.rows[0]).toMatchObject({
                state: "interrupted",
                message: "Task deadline changed before execution.",
            });
            const chat = await api.conversations.read({
                id: runs.rows[0]!.conversationId,
            });
            expect(
                chat.messages.find((message) => message.role === "assistant")?.state
            ).toBe("interrupted");
        } finally {
            await fixture.close();
        }
    }
);

test("due-task discovery yields to a human task start before acquiring task row locks", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    const held = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
    let transaction: Promise<void> | undefined;
    try {
        const task = await api.tasks.create({
            title: "Task admission race",
            description: "Synthetic",
            status: "todo",
            assignee: "mira",
            priority: "normal",
            labels: [],
            dueAt: new Date(Date.now() - 1000).toISOString(),
            completionCriteria: "Review",
            conversationId: null,
        });
        transaction = fixture.client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:task:operator:${task.id}`},0))`;
            held.resolve();
            await release.promise;
            await query`UPDATE mira_tasks SET title=title WHERE id=${task.id}`;
        });
        await held.promise;
        expect(await scheduleMiraRuns(fixture.client)).toBe(0);
        const [events] = await fixture.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_events WHERE task_id=${task.id}`;
        expect(events?.count).toBe(0);
    } finally {
        release.resolve();
        await transaction;
        await fixture.close();
    }
});

test("event dispatch waits for edited instructions instead of snapshotting an unlocked automation", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    const held = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
    let editing: Promise<void> | undefined;
    try {
        const automation = await api.automations.create({
            title: "Old title",
            prompt: "Old instruction",
            kind: "custom",
            schedule: { kind: "event", event: "task_due" },
            budgetSeconds: 60,
        });
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            version: 1,
            enabled: true,
            reason: null,
            until: null,
        });
        const task = await api.tasks.create({
            title: "Due",
            description: "Synthetic",
            status: "todo",
            assignee: "mira",
            priority: "normal",
            labels: [],
            dueAt: new Date(Date.now() - 1000).toISOString(),
            completionCriteria: "Review",
            conversationId: null,
        });
        const [row] = await fixture.client<
            { due: string }[]
        >`SELECT due_at::text AS due FROM mira_tasks WHERE id=${task.id}`;
        await fixture.client.begin((query) =>
            recordMiraEvent(query, {
                owner: "operator",
                kind: "task_due",
                key: `${task.id}:${row!.due}`,
                reference: task.id,
                taskId: task.id,
            })
        );
        editing = fixture.client.begin(async (query) => {
            await query`UPDATE mira_automations SET title='New title',prompt='New instruction',budget_seconds=120 WHERE id=${automation.id}`;
            held.resolve();
            await release.promise;
        });
        await held.promise;
        expect(await scheduleMiraRuns(fixture.client)).toBe(0);
        release.resolve();
        await editing;
        expect(await scheduleMiraRuns(fixture.client)).toBe(1);
        const [dispatched] = await fixture.client<
            { title: string; content: string; budget: number }[]
        >`SELECT c.title,m.content,r.budget_seconds AS budget FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id JOIN mira_messages m ON m.id=r.user_message_id WHERE r.automation_id=${automation.id}`;
        expect(dispatched).toMatchObject({ title: "New title", budget: 120 });
        expect(dispatched?.content).toStartWith("New instruction");
    } finally {
        release.resolve();
        await editing;
        await fixture.close();
    }
});
