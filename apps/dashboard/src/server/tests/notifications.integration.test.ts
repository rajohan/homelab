import { expect, test } from "bun:test";

import type { PublishNotification } from "@homelab/contracts/notifications";
import { capabilities } from "@homelab/contracts/operations";
import type { SQL } from "bun";

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

function publishCommitted(client: SQL, source: string, input: PublishNotification) {
    return client.begin((transaction) => publishNotification(transaction, source, input));
}

test("notification publication is immutable and deduplicated while acknowledgements belong to one operator", async () => {
    const fixture = await operationFixture();
    const caller = (id: string) =>
        appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id, capabilities },
        });
    try {
        const id = await publishCommitted(fixture.client, "test", content);
        expect(await publishCommitted(fixture.client, "test", content)).toBe(id);
        await expectOperationFailure(
            publishCommitted(fixture.client, "test", {
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
        await publishCommitted(fixture.client, "test", content);
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
            producer.notifications.acknowledgeBatch({
                through: producerPage.through ?? "1",
                action: "read",
            }),
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
            await publishCommitted(fixture.client, "batch", {
                ...content,
                key: String(index),
            });
        await publishCommitted(fixture.client, "batch", {
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
        const arriving = await publishCommitted(fixture.client, "batch", {
            ...content,
            key: "arriving",
        });
        // Simulate publication on a worker whose clock lags behind the web process.
        const skewed = "00000000-0000-7000-8000-000000000001";
        await fixture.client`UPDATE dashboard_notifications SET id = ${skewed} WHERE id = ${arriving}`;
        const refreshed = await caller.notifications.list({
            limit: 1,
            severity: "success",
        });
        expect(refreshed.notifications.map((item) => item.id)).toEqual([skewed]);
        expect(refreshed.nextCursor).toMatch(/^[1-9]\d*$/);
        const continuation = await caller.notifications.list({
            limit: 100,
            severity: "success",
            before: page.nextCursor,
        });
        expect(continuation.notifications.map((item) => item.id)).toEqual(
            older.notifications.map((item) => item.id)
        );
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
        expect(unreadSuccess.notifications.map((n) => n.id)).toEqual([skewed]);
        await caller.notifications.acknowledge({ id: skewed, action: "read" });
        expect(
            await caller.notifications.list({ state: "unread", severity: "warning" })
        ).toMatchObject({ unreadCount: 1 });
        await caller.notifications.acknowledgeBatch({ ...input, action: "dismissRead" });
        await caller.notifications.acknowledgeBatch({ ...input, action: "dismissRead" });
        const remaining = await caller.notifications.list({});
        expect(remaining.notifications).toHaveLength(2);
        expect(remaining.notifications.map((n) => n.id)).toContain(skewed);
    } finally {
        await fixture.close();
    }
});

test("publication cursors cannot advance past an uncommitted producer", async () => {
    const fixture = await operationFixture();
    const release = Promise.withResolvers<void>();
    const inserted = Promise.withResolvers<void>();
    let first: Promise<string> | undefined;
    let second: Promise<{ id: string }> | undefined;
    let observedSecond = Promise.resolve(false);
    try {
        const initial = await publishCommitted(fixture.client, "concurrent", content);
        const reader = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "reader", capabilities },
        });
        first = fixture.client.begin(async (transaction) => {
            const id = await publishNotification(transaction, "concurrent", {
                ...content,
                key: "held-open",
            });
            inserted.resolve();
            await release.promise;
            return id;
        });
        await Promise.race([inserted.promise, first]);
        // The independent automation endpoint must acquire the same lock inside
        // its own transaction, not on a pool connection in autocommit mode.
        second = appRouter
            .createCaller({
                operations: fixture,
                principal: { kind: "automation", id: "publisher", capabilities },
            })
            .notifications.publish({ ...content, key: "second" });
        let secondFinished = false;
        observedSecond = second.then(
            () => {
                secondFinished = true;
                return true;
            },
            () => {
                secondFinished = true;
                return true;
            }
        );
        let waiting = false;
        const deadline = performance.now() + 2000;
        while (!waiting && !secondFinished && performance.now() < deadline) {
            const [row] = await fixture.client<{ waiting: boolean }[]>`
                SELECT EXISTS (
                    SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
                    AND classid = 1869440354 AND objid = 2 AND NOT granted
                    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                ) AS waiting`;
            waiting = row?.waiting ?? false;
            if (!waiting) await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
        const page = await reader.notifications.list({});
        expect(page.notifications.map((item) => item.id)).toEqual([initial]);
        if (!page.through) throw new Error("Missing committed cursor");
        release.resolve();
        const [firstId, { id: secondId }] = await Promise.all([first, second]);
        const refreshed = await reader.notifications.list({});
        expect(refreshed.notifications.map((item) => item.id)).toEqual([
            secondId,
            firstId,
            initial,
        ]);
        expect(
            await reader.notifications.acknowledgeBatch({
                through: page.through,
                action: "read",
            })
        ).toEqual({ affected: 1, remaining: false });
        const unread = await reader.notifications.list({ state: "unread" });
        expect(unread.notifications.map((item) => item.id)).toEqual([secondId, firstId]);
    } finally {
        release.resolve();
        await Promise.allSettled([first, second, observedSecond]);
        await fixture.close();
    }
});

test("rolling back a producer releases publication ordering without leaking a notification", async () => {
    const fixture = await operationFixture();
    try {
        await expectOperationFailure(
            fixture.client.begin(async (transaction) => {
                await publishNotification(transaction, "rollback", content);
                throw new Error("Producer rolled back");
            }),
            "Producer rolled back"
        );
        expect(await fixture.client`SELECT id FROM dashboard_notifications`).toHaveLength(
            0
        );
        const ids = await Promise.all(
            Array.from({ length: 3 }, () =>
                publishCommitted(fixture.client, "rollback", content)
            )
        );
        expect(new Set(ids).size).toBe(1);
        expect(await fixture.client`SELECT id FROM dashboard_notifications`).toHaveLength(
            1
        );
    } finally {
        await fixture.close();
    }
});

test.each([100, 10_000, 10_001])(
    "notification batches report actual remaining work for %i records",
    async (count) => {
        const fixture = await operationFixture();
        try {
            await fixture.client`INSERT INTO dashboard_notifications (id, source, source_key, title, message, severity) SELECT gen_random_uuid(), 'bulk-fixture', number::text, 'Completed', 'Recorded event', 'success' FROM generate_series(1, ${count}::int) AS number`;
            const caller = appRouter.createCaller({
                operations: fixture,
                principal: { kind: "human", id: "operator", capabilities },
            });
            const page = await caller.notifications.list({ severity: "success" });
            if (!page.through) throw new Error("Missing bulk cursor");
            await publishCommitted(fixture.client, "bulk-fixture", {
                ...content,
                key: "new-arrival",
            });
            for (const action of ["read", "dismissRead"] as const) {
                let affected = 0;
                let remaining = true;
                let batches = 0;
                while (remaining && batches < 100) {
                    const result = await caller.notifications.acknowledgeBatch({
                        through: page.through,
                        severity: "success",
                        action,
                    });
                    affected += result.affected;
                    remaining = result.remaining;
                    batches += 1;
                }
                expect(affected).toBe(Math.min(count, 10_000));
                expect(batches).toBe(Math.min(Math.ceil(count / 100), 100));
                expect(remaining).toBe(count > 10_000);
                if (remaining)
                    expect(
                        await caller.notifications.acknowledgeBatch({
                            through: page.through,
                            severity: "success",
                            action,
                        })
                    ).toEqual({ affected: 1, remaining: false });
            }
            const remaining = await caller.notifications.list({});
            expect(remaining.unreadCount).toBe(1);
            expect(remaining.notifications).toHaveLength(1);
        } finally {
            await fixture.close();
        }
    },
    30_000
);

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
