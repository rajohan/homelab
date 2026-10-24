import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
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
