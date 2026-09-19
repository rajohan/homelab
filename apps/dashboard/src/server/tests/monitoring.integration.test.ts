import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { appRouter } from "../api/router";
import { alertsJob } from "../integrations/alerts/job";
import { readRules } from "../integrations/alerts/rules";
import { synchronizeAlerts } from "../integrations/alerts/synchronize";
import { readAlerts, type ObservedAlert } from "../integrations/alerts/transport";
import { readBackupCatalog } from "../integrations/backups/catalog";
import { collectBackups } from "../integrations/backups/inventory";
import { snapshotJob } from "../integrations/snapshots/job";
import { claimJob, commitClaim } from "../jobs/claims";
import { reportJobProgress } from "../jobs/progress";
import { enqueueJob, lockQueue } from "../jobs/queue";
import { createMonitoringFixture } from "../testing/monitoring";
import { operationFixture, expectOperationFailure } from "../testing/operations";

const alert: ObservedAlert = {
    key: "a".repeat(64),
    name: "HostDown",
    host: "demo",
    service: "node",
    severity: "error",
    state: "active",
    startedAt: "2026-09-01T10:00:00.000Z",
};

test("rule inventory includes normal and heartbeat rules but excludes recording rules and private metadata", async () => {
    const rule = {
        name: "Watchdog",
        type: "alerting",
        state: "firing",
        health: "ok",
        lastEvaluation: new Date().toISOString(),
        query: "private",
        annotations: { summary: "private" },
    };
    let rules = [
        rule,
        { ...rule, name: "Normal", state: "inactive" },
        { ...rule, name: "Pending", state: "pending" },
        { ...rule, name: "Broken", health: "err" },
        { ...rule, name: "Old", lastEvaluation: "2020-01-01T00:00:00Z" },
        { ...rule, name: "recorded", type: "recording" },
    ];
    let files = ["/private/first.yml"];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
            expect(new URL(request.url).pathname).toBe("/api/v1/rules");
            expect(request.headers.get("authorization")).toBe("Bearer synthetic");
            return Response.json({
                status: "success",
                data: {
                    groups: files.map((file) => ({
                        name: "health",
                        file,
                        interval: 30,
                        rules,
                    })),
                },
            });
        },
    });
    try {
        const configuration = { url: server.url.origin, token: "synthetic" };
        const result = await readRules(configuration, AbortSignal.timeout(2000));
        expect(result.rules).toHaveLength(5);
        expect(result.rules.find((row) => row.name === "Normal")).toMatchObject({
            health: "healthy",
            state: "inactive",
        });
        expect(result.rules.find((row) => row.name === "Old")).toMatchObject({
            health: "unknown",
            state: "unknown",
        });
        expect(result.rules.find((row) => row.name === "Broken")?.health).toBe("error");
        expect(JSON.stringify(result)).not.toContain("private");
        rules = [rule, rule];
        files = ["/private/first.yml", "/private/second.yml"];
        const repeated = await readRules(configuration, AbortSignal.timeout(2000));
        expect(repeated.rules).toHaveLength(4);
        expect(new Set(repeated.rules.map((item) => item.id)).size).toBe(4);
        expect(JSON.stringify(repeated)).not.toContain("private");
        files.reverse();
        const reordered = await readRules(configuration, AbortSignal.timeout(2000));
        expect(reordered.rules.map((item) => item.id).toSorted()).toEqual(
            repeated.rules.map((item) => item.id).toSorted()
        );
        files = ["/private/first.yml", "/private/first.yml"];
        await expectOperationFailure(
            readRules(configuration, AbortSignal.timeout(2000)),
            "Invalid monitoring"
        );
    } finally {
        await server.stop(true);
    }
});

test("PBS catalog reads exact namespaces, distinguishes missing size from zero and strips archive metadata", async () => {
    const now = Math.floor(Date.now() / 1000) - 60;
    const row = {
        "backup-type": "vm",
        "backup-id": "100",
        "backup-time": now,
        size: 4096,
        protected: true,
        verification: { state: "ok" },
        files: [{ filename: "private" }],
        comment: "private",
        owner: "private",
    };
    let mode = "valid";
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
            const url = new URL(request.url);
            expect(url.pathname).toBe("/api2/json/admin/datastore/backups/snapshots");
            expect(url.searchParams.get("ns")).toBe("nested/scope");
            expect(request.headers.get("authorization")).toBe(
                "PBSAPIToken=demo@pbs!audit=synthetic"
            );
            if (mode === "failed") return new Response("private", { status: 403 });
            if (mode === "duplicate") return Response.json({ data: [row, row] });
            if (mode === "future")
                return Response.json({ data: [{ ...row, "backup-time": now + 3600 }] });
            return Response.json({
                data: [
                    row,
                    {
                        ...row,
                        "backup-time": now - 60,
                        size: null,
                        protected: false,
                        verification: null,
                    },
                    {
                        ...row,
                        "backup-time": now - 120,
                        size: 0,
                        verification: { state: "failed" },
                    },
                ],
            });
        },
    });
    const configuration = {
        url: server.url.origin,
        token: "demo@pbs!audit=synthetic",
        stores: [{ datastore: "backups", namespace: "nested/scope" }],
    };
    try {
        const result = await readBackupCatalog(configuration, AbortSignal.timeout(2000));
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]).toMatchObject({
            snapshotCount: 3,
            latestSizeBytes: 4096,
        });
        expect(result.snapshots.map((item) => item.sizeBytes)).toEqual([4096, null, 0]);
        expect(result.snapshots.map((item) => item.verification)).toEqual([
            "verified",
            "unverified",
            "failed",
        ]);
        expect(JSON.stringify(result)).not.toContain("private");
        for (const invalid of ["failed", "duplicate", "future"]) {
            mode = invalid;
            await expectOperationFailure(
                readBackupCatalog(configuration, AbortSignal.timeout(2000)),
                invalid === "failed" ? "failed" : "Invalid"
            );
        }
    } finally {
        await server.stop(true);
    }
});

test("catalog and rule routes enforce permissions, page without duplicates and mark stale observations", async () => {
    const fixture = await operationFixture();
    const monitoring = createMonitoringFixture();
    const configuration = {
        url: monitoring.url,
        token: "demo@pbs!reader=synthetic-only",
        stores: [{ datastore: "demo-backups", namespace: "" }],
    };
    const operations = {
        ...fixture,
        backupCatalog: configuration,
        rules: { url: monitoring.url, token: undefined },
    };
    const caller = appRouter.createCaller({
        operations,
        principal: { kind: "human", id: "operator", capabilities },
    });
    try {
        const emptyCatalog = await caller.backups.catalog();
        const emptyRules = await caller.alerts.rules();
        expect(emptyCatalog.inventory).toBeNull();
        expect(emptyRules.inventory).toBeNull();
        const catalog = await readBackupCatalog(configuration, AbortSignal.timeout(3000));
        const rules = await readRules(operations.rules, AbortSignal.timeout(3000));
        for (const [key, inventory] of [
            ["backups.catalog", catalog],
            ["monitoring.rules", rules],
        ] as const)
            await fixture.client`INSERT INTO operation_snapshots (key, value, captured_at) VALUES (${key}, ${JSON.stringify(inventory)}::text::jsonb, now())`;
        const groupId = catalog.groups.find((group) => group.name === "vm/demo-main")?.id;
        if (!groupId) throw new Error("Missing sample group");
        const summary = await caller.backups.catalog();
        expect(summary.inventory).not.toHaveProperty("snapshots");
        expect(summary.stale).toBe(false);
        const first = await caller.backups.snapshots({ groupId });
        const second = await caller.backups.snapshots({
            groupId,
            before: first.nextCursor ?? undefined,
        });
        expect(first.snapshots).toHaveLength(30);
        expect(second.snapshots).toHaveLength(15);
        expect(
            new Set([...first.snapshots, ...second.snapshots].map((item) => item.id)).size
        ).toBe(45);
        const blocked = appRouter.createCaller({
            operations,
            principal: { kind: "automation", id: "none", capabilities: [] },
        });
        await expectOperationFailure(blocked.backups.catalog(), "permission");
        await expectOperationFailure(
            blocked.backups.snapshots({ groupId }),
            "permission"
        );
        await expectOperationFailure(blocked.alerts.rules(), "permission");
        await fixture.client`UPDATE operation_snapshots SET captured_at = now() - interval '20 minutes'`;
        const oldCatalog = await caller.backups.catalog();
        const oldSnapshots = await caller.backups.snapshots({ groupId });
        const oldRules = await caller.alerts.rules();
        expect(oldCatalog.stale).toBe(true);
        expect(oldSnapshots.stale).toBe(true);
        expect(oldRules.stale).toBe(true);
    } finally {
        await monitoring.close();
        await fixture.close();
    }
});

test("snapshot jobs preserve complete inventories on read failure and reject expired claims", async () => {
    const fixture = await operationFixture();
    let fail = true;
    const handler = snapshotJob({
        key: "backups.catalog",
        label: "Catalog",
        description: "Reading metadata.",
        capability: "backups:refresh",
        intervalSeconds: 300,
        read: () =>
            fail
                ? Promise.reject(new Error("Unavailable catalog"))
                : Promise.resolve({ groups: [], snapshots: [] }),
    });
    try {
        await fixture.client`INSERT INTO operation_snapshots (key, value, captured_at) VALUES ('backups.catalog', '{"preserved":true}'::jsonb, now() - interval '20 minutes')`;
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            await enqueueJob(transaction, handler.definition, "test", "snapshot-poll");
        });
        const run = await claimJob(fixture.client, await fixture.registerWorker(), [
            handler.definition.key,
        ]);
        if (!run) throw new Error("Missing claim");
        const context = {
            runId: run.id,
            leaseToken: run.lease_token,
            signal: AbortSignal.timeout(5000),
            reportProgress: (message: string) =>
                reportJobProgress(fixture.client, run, message),
            commit: (write: Parameters<typeof commitClaim>[2]) =>
                commitClaim(fixture.client, run, write),
        };
        await expectOperationFailure(handler.execute({}, context), "Unavailable");
        const preserved = await fixture.client<
            { value: unknown }[]
        >`SELECT value FROM operation_snapshots WHERE key = 'backups.catalog'`;
        expect(preserved[0]?.value).toEqual({ preserved: true });
        fail = false;
        await handler.execute({}, context);
        const refreshed = await fixture.client<
            { value: unknown }[]
        >`SELECT value FROM operation_snapshots WHERE key = 'backups.catalog'`;
        expect(refreshed[0]?.value).toEqual({ groups: [], snapshots: [] });
        await fixture.client`UPDATE job_runs SET lease_expires_at = now() - interval '1 second' WHERE id = ${run.id}`;
        await expectOperationFailure(handler.execute({}, context), "ownership");
    } finally {
        await fixture.close();
    }
});

test("incident reconciliation is idempotent, atomic, permissioned and independent of read receipts", async () => {
    const fixture = await operationFixture();
    const operations = {
        ...fixture,
        alerts: {
            url: "https://monitor.example.test",
            token: undefined,
            excludedNames: ["Watchdog"],
        },
    };
    const caller = appRouter.createCaller({
        operations,
        principal: { kind: "human", id: "operator", capabilities },
    });
    try {
        await expectOperationFailure(
            appRouter
                .createCaller({
                    operations,
                    principal: { kind: "automation", id: "none", capabilities: [] },
                })
                .alerts.list({}),
            "permission"
        );
        const observation1 = await caller.alerts.list({});
        expect(observation1.capturedAt).toBeNull();
        await fixture.client.begin((transaction) =>
            synchronizeAlerts(transaction, [alert])
        );
        await fixture.client.begin((transaction) =>
            synchronizeAlerts(transaction, [alert])
        );
        let data = await caller.alerts.list({});
        expect(data.incidents[0]?.state).toBe("active");
        expect(data.stale).toBe(false);
        const notifications = await fixture.client<
            { id: string }[]
        >`SELECT id FROM dashboard_notifications`;
        expect(notifications).toHaveLength(1);
        const id = notifications[0]?.id;
        if (!id) throw new Error("Missing notification");
        await fixture.client`INSERT INTO notification_receipts (notification_id, actor, read_at, dismissed_at) VALUES (${id}, 'human:operator', now(), now())`;
        await fixture.client.begin((transaction) =>
            synchronizeAlerts(transaction, [{ ...alert, state: "suppressed" }])
        );
        const observation2 = await caller.alerts.list({});
        expect(observation2.incidents[0]?.state).toBe("suppressed");
        await fixture.client.begin((transaction) => synchronizeAlerts(transaction, []));
        const observation3 = await caller.alerts.list({});
        expect(observation3.incidents).toHaveLength(0);
        const observation4 = await caller.alerts.list({ state: "resolved" });
        expect(observation4.incidents[0]).toMatchObject({
            state: "resolved",
            name: "HostDown",
        });
        expect(await fixture.client`SELECT id FROM dashboard_notifications`).toHaveLength(
            2
        );
        await fixture.client.begin((transaction) => synchronizeAlerts(transaction, []));
        expect(await fixture.client`SELECT id FROM dashboard_notifications`).toHaveLength(
            2
        );
        await expectOperationFailure(
            fixture.client.begin(async (transaction) => {
                await synchronizeAlerts(transaction, [{ ...alert, key: "b".repeat(64) }]);
                throw new Error("Rollback incident");
            }),
            "Rollback"
        );
        const observation5 = await caller.alerts.list({});
        expect(observation5.incidents).toHaveLength(0);
        await fixture.client`UPDATE operation_snapshots SET captured_at = now() - interval '4 minutes' WHERE key = 'alerts'`;
        data = await caller.alerts.list({});
        expect(data.stale).toBe(true);
        await fixture.client.begin((transaction) =>
            synchronizeAlerts(
                transaction,
                Array.from({ length: 35 }, (_, index) => ({
                    ...alert,
                    key: String(index).padStart(64, "0"),
                }))
            )
        );
        const first = await caller.alerts.list({ limit: 20 });
        const second = await caller.alerts.list({
            limit: 20,
            before: first.nextCursor ?? undefined,
        });
        expect(first.incidents).toHaveLength(20);
        expect(second.incidents).toHaveLength(15);
        expect(
            new Set([...first.incidents, ...second.incidents].map((item) => item.id)).size
        ).toBe(35);
    } finally {
        await fixture.close();
    }
});

test("resolved history orders by resolution time with stable microsecond and ID cursor boundaries", async () => {
    const fixture = await operationFixture();
    const caller = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    });
    try {
        const older = "00000000-0000-7000-8000-000000000001";
        const tieLow = "00000000-0000-7000-8000-000000000002";
        const tieHigh = "00000000-0000-7000-8000-000000000003";
        const newestOpened = "00000000-0000-7000-8000-000000000004";
        for (const [id, resolved] of [
            [older, "2026-09-19T10:00:00.123457Z"],
            [tieLow, "2026-09-19T10:00:00.123456Z"],
            [tieHigh, "2026-09-19T10:00:00.123456Z"],
            [newestOpened, "2026-09-18T10:00:00.000000Z"],
        ]) {
            await fixture.client`INSERT INTO operational_incidents (id, source_key, name, severity, state, started_at, resolved_at) VALUES (${id}, ${id}, 'Synthetic', 'warning', 'resolved', '2026-09-01T00:00:00Z', ${resolved}::timestamptz)`;
        }
        const first = await caller.alerts.list({ state: "resolved", limit: 1 });
        expect(first.incidents.map((row) => row.id)).toEqual([older]);
        expect(first.nextCursor).toEqual({
            id: older,
            resolvedAt: "2026-09-19T10:00:00.123457Z",
        });
        // Pagination must not depend on the boundary record surviving retention.
        await fixture.client`DELETE FROM operational_incidents WHERE id = ${older}`;
        const second = await caller.alerts.list({
            state: "resolved",
            limit: 1,
            before: first.nextCursor ?? undefined,
        });
        expect(second.incidents.map((row) => row.id)).toEqual([tieHigh]);
        const third = await caller.alerts.list({
            state: "resolved",
            limit: 1,
            before: second.nextCursor ?? undefined,
        });
        expect(third.incidents.map((row) => row.id)).toEqual([tieLow]);
        const fourth = await caller.alerts.list({
            state: "resolved",
            limit: 1,
            before: third.nextCursor ?? undefined,
        });
        expect(fourth.incidents.map((row) => row.id)).toEqual([newestOpened]);
        expect(fourth.nextCursor).toBeNull();
        await expectOperationFailure(
            caller.alerts.list({ state: "resolved", before: { id: older } }),
            "cursor"
        );
        await expectOperationFailure(
            caller.alerts.list({
                state: "current",
                before: first.nextCursor ?? undefined,
            }),
            "cursor"
        );
    } finally {
        await fixture.close();
    }
});

test("Alertmanager transport strips private metadata, includes suppressed alerts and rejects bad inventory", async () => {
    let fail = false;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
            expect(new URL(request.url).searchParams.get("silenced")).toBe("true");
            expect(request.headers.get("authorization")).toBe("Bearer synthetic-token");
            if (fail) return Response.json({ private: "not exposed" }, { status: 500 });
            return Response.json([
                {
                    fingerprint: "0123456789abcdef",
                    labels: {
                        alertname: "HostDown",
                        host: "demo",
                        severity: "critical",
                        secret: "private",
                    },
                    annotations: { description: "private URL" },
                    startsAt: "2026-09-01T00:00:00Z",
                    endsAt: "2026-10-01T00:00:00Z",
                    status: { state: "suppressed" },
                },
                {
                    fingerprint: "1123456789abcdef",
                    labels: { alertname: "Watchdog" },
                    startsAt: "2026-09-01T00:00:00Z",
                    endsAt: "2026-10-01T00:00:00Z",
                    status: { state: "active" },
                },
            ]);
        },
    });
    const configuration = {
        url: server.url.origin,
        token: "synthetic-token",
        excludedNames: ["Watchdog"],
    };
    try {
        const data = await readAlerts(configuration, AbortSignal.timeout(2000));
        expect(data).toHaveLength(1);
        expect(data[0]).toMatchObject({
            name: "HostDown",
            state: "suppressed",
            severity: "error",
        });
        expect(JSON.stringify(data)).not.toContain("private");
        fail = true;
        await expectOperationFailure(
            readAlerts(configuration, AbortSignal.timeout(2000)),
            "failed"
        );
    } finally {
        await server.stop(true);
    }
});

test("a failed or superseded alert poll cannot resolve incidents or advance freshness", async () => {
    const fixture = await operationFixture();
    let fail = true;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
            fail ? new Response("private", { status: 503 }) : Response.json([]),
    });
    const handler = alertsJob({
        url: server.url.origin,
        token: undefined,
        excludedNames: [],
    });
    try {
        await fixture.client.begin((transaction) =>
            synchronizeAlerts(transaction, [alert])
        );
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            await enqueueJob(transaction, handler.definition, "test", "alert-poll");
        });
        const run = await claimJob(fixture.client, await fixture.registerWorker(), [
            handler.definition.key,
        ]);
        if (!run) throw new Error("Missing claim");
        const context = {
            runId: run.id,
            leaseToken: run.lease_token,
            signal: AbortSignal.timeout(5000),
            reportProgress: (message: string) =>
                reportJobProgress(fixture.client, run, message),
            commit: (write: Parameters<typeof commitClaim>[2]) =>
                commitClaim(fixture.client, run, write),
        };
        await expectOperationFailure(handler.execute({}, context), "failed");
        expect(
            await fixture.client`SELECT id FROM operational_incidents WHERE state = 'active'`
        ).toHaveLength(1);
        fail = false;
        await handler.execute({}, context);
        expect(
            await fixture.client`SELECT id FROM operational_incidents WHERE state = 'resolved'`
        ).toHaveLength(1);
        await fixture.client`UPDATE job_runs SET lease_expires_at = now() - interval '1 second' WHERE id = ${run.id}`;
        await expectOperationFailure(handler.execute({}, context), "ownership");
    } finally {
        await server.stop(true);
        await fixture.close();
    }
});

test("backup collection validates instant vectors and stores no unrelated metric labels", async () => {
    const now = Date.now() / 1000;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
            Response.json({
                status: "success",
                data: {
                    resultType: "vector",
                    result: [
                        {
                            metric: { __name__: "up", host: "db", job: "node" },
                            value: [now, "1"],
                        },
                        ...Object.entries({
                            history_known: 1,
                            last_completed_success: 1,
                            last_success_timestamp_seconds: now - 60,
                            max_age_seconds: 3600,
                        }).map(([name, value]) => ({
                            metric: {
                                __name__: "homelab_backup_" + name,
                                host: "db",
                                job: "node",
                                task: "database",
                                private: "omitted",
                            },
                            value: [now, String(value)],
                        })),
                    ],
                },
            }),
    });
    try {
        const result = await collectBackups(
            { url: server.url.origin, token: undefined },
            null,
            AbortSignal.timeout(2000)
        );
        expect(result.backups[0]?.state).toBe("healthy");
        expect(JSON.stringify(result)).not.toContain("omitted");
    } finally {
        await server.stop(true);
    }
});
