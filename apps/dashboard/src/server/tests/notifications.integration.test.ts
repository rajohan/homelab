import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { appRouter } from "../api/router";
import { claimJob, settleClaim } from "../jobs/claims";
import { maintenanceJob } from "../jobs/maintenance";
import { enqueueJob, lockQueue } from "../jobs/queue";
import { publishNotification } from "../notifications/publish";
import { operationFixture, expectOperationFailure } from "../testing/operations";

const content = {
    key: "event-1",
    title: "Service restarted",
    message: "The requested operation completed.",
    severity: "success" as const,
    destination: "jobs" as const,
};

test("notification publication is immutable and deduplicated while acknowledgements belong to one operator", async () => {
    const fixture = await operationFixture();
    const caller = (id: string) =>
        appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id, capabilities },
        });
    try {
        const id = await publishNotification(fixture.client, "test", content);
        expect(await publishNotification(fixture.client, "test", content)).toBe(id);
        await expectOperationFailure(
            publishNotification(fixture.client, "test", {
                ...content,
                message: "Different content",
            }),
            "different content"
        );
        const first = caller("first"),
            second = caller("second");
        expect(await first.notifications.list({})).toMatchObject({ unreadCount: 1 });
        await first.notifications.acknowledge({ id, action: "read" });
        const readPage = await first.notifications.list({ state: "read" });
        expect(readPage.notifications).toHaveLength(1);
        expect(await second.notifications.list({})).toMatchObject({ unreadCount: 1 });
        await first.notifications.acknowledge({ id, action: "unread" });
        expect(await first.notifications.list({})).toMatchObject({ unreadCount: 1 });
        await first.notifications.acknowledge({ id, action: "dismiss" });
        await publishNotification(fixture.client, "test", content);
        await first.notifications.acknowledge({ id, action: "read" });
        expect(await first.notifications.list({})).toMatchObject({ notifications: [] });
        const secondPage = await second.notifications.list({});
        expect(secondPage.notifications).toHaveLength(1);
        await expectOperationFailure(
            first.notifications.acknowledge({ id: crypto.randomUUID(), action: "read" }),
            "no longer exists"
        );
    } finally {
        await fixture.close();
    }
});

test("notification permissions separate automation producers from personal acknowledgements", async () => {
    const fixture = await operationFixture();
    try {
        const none = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "automation", id: "none", capabilities: [] },
        });
        await expectOperationFailure(none.notifications.list({}), "permission");
        await expectOperationFailure(none.notifications.publish(content), "permission");
        const producer = appRouter.createCaller({
            operations: fixture,
            principal: {
                kind: "automation",
                id: "producer",
                capabilities: ["notifications:publish", "notifications:read"],
            },
        });
        const { id } = await producer.notifications.publish(content);
        const producerPage = await producer.notifications.list({});
        expect(producerPage.notifications[0]?.source).toBe("automation:producer");
        await expectOperationFailure(
            producer.notifications.acknowledge({ id, action: "dismiss" }),
            "signed-in operator"
        );
        await expectOperationFailure(
            producer.notifications.acknowledgeBatch({ through: id, action: "read" }),
            "signed-in operator"
        );
        const human = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "human", capabilities },
        });
        await expectOperationFailure(
            human.notifications.publish(content),
            "automation account"
        );
        await expectOperationFailure(
            appRouter.createCaller({}).notifications.list({}),
            "Sign in"
        );
        await expectOperationFailure(
            producer.notifications.publish({
                ...content,
                destination: "https://example.test" as "jobs",
            }),
            "Invalid"
        );
    } finally {
        await fixture.close();
    }
});

test("filtered notification pages and bounded bulk actions do not swallow new arrivals", async () => {
    const fixture = await operationFixture();
    try {
        for (let index = 0; index < 105; index += 1)
            await publishNotification(fixture.client, "batch", {
                ...content,
                key: String(index),
            });
        await publishNotification(fixture.client, "batch", {
            ...content,
            key: "warning",
            severity: "warning",
        });
        const caller = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "operator", capabilities },
        });
        const page = await caller.notifications.list({ limit: 100, severity: "success" });
        expect(page.notifications).toHaveLength(100);
        expect(page.unreadCount).toBe(105);
        if (!page.nextCursor || !page.through)
            throw new Error("Missing notification cursor");
        const older = await caller.notifications.list({
            limit: 100,
            severity: "success",
            before: page.nextCursor,
        });
        expect(older.notifications).toHaveLength(5);
        expect(older.nextCursor).toBeNull();
        const arriving = await publishNotification(fixture.client, "batch", {
            ...content,
            key: "arriving",
        });
        const input = {
            through: page.through,
            severity: "success" as const,
            action: "read" as const,
        };
        expect(await caller.notifications.acknowledgeBatch(input)).toEqual({
            affected: 100,
            remaining: true,
        });
        expect(await caller.notifications.acknowledgeBatch(input)).toEqual({
            affected: 5,
            remaining: false,
        });
        const unreadSuccess = await caller.notifications.list({
            state: "unread",
            severity: "success",
        });
        expect(unreadSuccess.notifications.map((n) => n.id)).toEqual([arriving]);
        expect(
            await caller.notifications.list({ state: "unread", severity: "warning" })
        ).toMatchObject({ unreadCount: 1 });
        await caller.notifications.acknowledgeBatch({ ...input, action: "dismissRead" });
        await caller.notifications.acknowledgeBatch({ ...input, action: "dismissRead" });
        const remaining = await caller.notifications.list({});
        expect(remaining.notifications).toHaveLength(2);
    } finally {
        await fixture.close();
    }
});

test("final job notifications share settlement and retries do not report premature failure", async () => {
    const fixture = await operationFixture();
    try {
        const definition = { ...maintenanceJob(30).definition, attemptLimit: 2 };
        const id = await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            return enqueueJob(
                transaction,
                definition,
                "human:operator",
                "notification-test"
            );
        });
        const first = await claimJob(fixture.client, crypto.randomUUID(), [
            definition.key,
        ]);
        if (!first) throw new Error("Missing first claim");
        await settleClaim(fixture.client, first, "failed");
        expect(await fixture.client`SELECT id FROM dashboard_notifications`).toHaveLength(
            0
        );
        await fixture.client`UPDATE job_runs SET available_at=now() WHERE id=${id}`;
        const second = await claimJob(fixture.client, crypto.randomUUID(), [
            definition.key,
        ]);
        if (!second) throw new Error("Missing second claim");
        await settleClaim(fixture.client, second, "timed_out");
        await settleClaim(fixture.client, second, "timed_out");
        const rows = await fixture.client<
            { severity: string; source_key: string }[]
        >`SELECT severity,source_key FROM dashboard_notifications`;
        expect(rows).toEqual([{ severity: "error", source_key: id }]);
    } finally {
        await fixture.close();
    }
});
