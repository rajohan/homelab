import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { createReport } from "@homelab/mira/data/documents";
import { claimMiraRun, finishMiraRun, scheduleMiraRuns } from "@homelab/mira/data/queue";
import { publishNotification } from "@homelab/notifications";

import { appRouter } from "../api/router";
import {
    acknowledgeNotification,
    acknowledgeNotificationBatch,
    listNotifications,
} from "../notifications/repository";
import { operationFixture } from "../testing/operations";

const page = { state: "all" as const, limit: 30 };

test("private notifications isolate content, counts, single receipts and bulk receipts", async () => {
    const fixture = await operationFixture();
    try {
        const content = {
            key: "private",
            title: "Private Mira report",
            message: "Personal synthetic content",
            severity: "info" as const,
            destination: "reports" as const,
        };
        const id = await fixture.client.begin((query) =>
            publishNotification(query, "mira", content, "human:owner")
        );
        expect(
            await fixture.client.begin((query) =>
                publishNotification(query, "mira", content, "human:owner")
            )
        ).toBe(id);
        await rejects(
            fixture.client.begin((query) =>
                publishNotification(query, "mira", content, "human:other")
            ),
            /different content/
        );
        const owned = await listNotifications(fixture.client, "human:owner", page);
        expect(owned.unreadCount).toBe(1);
        expect(owned.notifications[0]?.id).toBe(id);
        expect(
            await listNotifications(fixture.client, "human:other", page)
        ).toMatchObject({
            notifications: [],
            unreadCount: 0,
            readCount: 0,
            through: null,
        });
        await rejects(
            acknowledgeNotification(fixture.client, "human:other", id, "read"),
            /no longer exists/
        );
        expect(
            await acknowledgeNotificationBatch(fixture.client, "human:other", {
                action: "read",
                through: owned.through!,
            })
        ).toEqual({ affected: 0, remaining: false });
        expect(
            await acknowledgeNotificationBatch(fixture.client, "human:owner", {
                action: "read",
                through: owned.through!,
            })
        ).toEqual({ affected: 1, remaining: false });
        expect(
            await listNotifications(fixture.client, "human:owner", page)
        ).toMatchObject({ readCount: 1 });
    } finally {
        await fixture.close();
    }
});

test("heartbeat reports stay quiet for unchanged observations and intentional pauses", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const automation = await api.automations.create({
            title: "Heartbeat",
            prompt: "Review synthetic observations",
            kind: "custom",
            delivery: "changes",
            budgetSeconds: 60,
            schedule: { kind: "interval", intervalSeconds: 60 },
        });
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            enabled: true,
            version: 1,
            reason: null,
            until: null,
        });
        const next = async () => {
            await fixture.client`UPDATE mira_automations SET next_run_at = now() - interval '1 minute' WHERE id = ${automation.id}`;
            expect(await scheduleMiraRuns(fixture.client)).toBe(1);
            const run = await claimMiraRun(
                fixture.client,
                crypto.randomUUID(),
                "general"
            );
            if (!run) throw new Error("Expected synthetic run");
            return run;
        };
        const complete = async (
            run: NonNullable<Awaited<ReturnType<typeof claimMiraRun>>>
        ) => {
            await createReport(
                {
                    client: fixture.client,
                    owner: "operator",
                    actor: `mira:${run.id}`,
                    run,
                },
                {
                    title: "Report",
                    markdown: `Synthetic report ${run.id}`,
                    kind: "other",
                    taskId: null,
                },
                run.id
            );
            await finishMiraRun(fixture.client, run, {
                state: "completed",
                text: "Done",
                message: null,
            });
        };
        await complete(await next());
        expect(
            await listNotifications(fixture.client, "human:operator", page)
        ).toMatchObject({ unreadCount: 1 });
        await complete(await next());
        expect(
            await listNotifications(fixture.client, "human:operator", page)
        ).toMatchObject({ unreadCount: 1 });
        const changedDuringRun = await next();
        const task = await api.tasks.create({
            title: "New blocker",
            description: "Synthetic change",
            status: "blocked",
            assignee: "operator",
            priority: "high",
            labels: [],
            dueAt: null,
            completionCriteria: "Review",
            conversationId: null,
        });
        await complete(changedDuringRun);
        expect(
            await listNotifications(fixture.client, "human:operator", page)
        ).toMatchObject({ unreadCount: 2 });
        await complete(await next());
        expect(
            await listNotifications(fixture.client, "human:operator", page)
        ).toMatchObject({ unreadCount: 2 });
        await fixture.client`INSERT INTO operation_snapshots (key,value,captured_at) VALUES ('synthetic.observation','{}'::jsonb,now())`;
        await complete(await next());
        expect(
            await listNotifications(fixture.client, "human:operator", page)
        ).toMatchObject({ unreadCount: 3 });
        await complete(await next());
        expect(
            await listNotifications(fixture.client, "human:operator", page)
        ).toMatchObject({ unreadCount: 3 });
        await api.tasks.addProgress({
            taskId: task.id,
            text: "Verified progress without a task edit",
        });
        await complete(await next());
        expect(
            await listNotifications(fixture.client, "human:operator", page)
        ).toMatchObject({ unreadCount: 4 });
        await complete(await next());
        expect(
            await listNotifications(fixture.client, "human:operator", page)
        ).toMatchObject({ unreadCount: 4 });
        const running = await next();
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            enabled: false,
            version: 2,
            reason: "Planned pause",
            until: null,
        });
        await finishMiraRun(fixture.client, running, {
            state: "failed",
            text: "",
            message: "Synthetic failure",
        });
        expect(
            await listNotifications(fixture.client, "human:operator", page)
        ).toMatchObject({ unreadCount: 4 });
        expect(
            await listNotifications(fixture.client, "human:other", page)
        ).toMatchObject({ unreadCount: 0 });
    } finally {
        await fixture.close();
    }
});

test.each([false, true])(
    "interrupted automatic work is attention-worthy unless explicitly cancelled (%s)",
    async (cancelled) => {
        const fixture = await operationFixture();
        const api = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "operator", capabilities },
        }).mira;
        try {
            const automation = await api.automations.create({
                title: "Interrupted automation",
                prompt: "Synthetic",
                kind: "custom",
                delivery: "changes",
                budgetSeconds: 60,
                schedule: { kind: "interval", intervalSeconds: 60 },
            });
            await api.controls.setEnabled({
                key: `automation:${automation.id}`,
                version: 1,
                enabled: true,
                reason: null,
                until: null,
            });
            await fixture.client`UPDATE mira_automations SET next_run_at=now()-interval '1 minute' WHERE id=${automation.id}`;
            expect(await scheduleMiraRuns(fixture.client)).toBe(1);
            const run = await claimMiraRun(
                fixture.client,
                crypto.randomUUID(),
                "general"
            );
            if (!run) throw new Error("Expected run");
            if (cancelled) await api.runs.cancel({ id: run.id });
            await finishMiraRun(fixture.client, run, {
                state: "interrupted",
                text: "Partial work",
                message: null,
            });
            const runs = await api.runs.list({ search: "", archived: false });
            expect(runs.rows[0]?.state).toBe(
                cancelled ? "interrupted" : "needs_attention"
            );
            if (!cancelled)
                expect(runs.rows[0]?.message).toContain("interrupted before completing");
            const notices = await listNotifications(
                fixture.client,
                "human:operator",
                page
            );
            expect(notices.notifications).toHaveLength(cancelled ? 0 : 1);
        } finally {
            await fixture.close();
        }
    }
);
