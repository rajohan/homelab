import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { appRouter } from "../api/router";
import { performApplicationAction } from "../integrations/applications/actions";
import { bindApplicationHosts } from "../integrations/applications/configuration";
import { createDockerPort } from "../integrations/applications/docker";
import { collectApplications } from "../integrations/applications/inventory";
import { applicationJobs } from "../integrations/applications/jobs";
import {
    readApplicationInventory,
    selectionRevision,
} from "../integrations/applications/selection";
import { claimJob } from "../jobs/claims";
import { maintenanceJob } from "../jobs/maintenance";
import { enqueueJob, lockQueue } from "../jobs/queue";
import { createJobRegistry } from "../jobs/registry";
import { hostResourceKey } from "../jobs/resources";
import { createApplicationFixture } from "../testing/applications";
import { operationFixture, expectOperationFailure } from "../testing/operations";

test.each([false, true])(
    "lifecycle admission leases its physical host across different endpoint aliases=%s",
    async (alias) => {
        const database = await operationFixture(),
            docker = createApplicationFixture();
        try {
            const other = {
                ...docker.target,
                id: "other",
                endpoint: "https://other.invalid",
            };
            const targets = alias
                ? bindApplicationHosts(
                      [docker.target, other],
                      [{ source: docker.target.id, host: "192.0.2.10" }]
                  )
                : [docker.target, other];
            const registry = createJobRegistry(applicationJobs(targets, database.client));
            const inventory = await collectApplications(
                [docker.target],
                (target) => createDockerPort(target, {}),
                AbortSignal.timeout(3000)
            );
            await database.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('applications.inventory',${JSON.stringify(inventory)}::text::jsonb,now())`;
            const application = inventory.hosts[0]!.applications[0]!;
            const principal = { kind: "human" as const, id: "operator", capabilities };
            const caller = appRouter.createCaller({
                operations: { ...database, registry, applicationTargets: targets },
                principal,
                verifyHuman: () => Promise.resolve(principal),
            });
            const result = await caller.applications.request({
                host: docker.target.id,
                selection: { kind: "container", target: application.containerId },
                revision: application.revision,
                operation: "restart",
                requestId: crypto.randomUUID(),
            });
            const worker = await database.registerWorker();
            const lifecycle = await claimJob(database.client, worker, [
                "applications.restart",
            ]);
            if (!lifecycle) throw new Error("Expected lifecycle claim");
            expect(lifecycle.id).toBe(result.id);
            const selectedKey = hostResourceKey(
                    alias ? "192.0.2.10" : new URL(docker.target.endpoint).hostname
                ),
                otherKey = hostResourceKey("other.invalid");
            expect(lifecycle.resource_keys).toContain("applications:inventory");
            expect(lifecycle.resource_keys).toContain(selectedKey);
            expect(lifecycle.resource_keys).toHaveLength(alias ? 3 : 2);
            for (const [key, host] of [
                ["fixture.update.selected", selectedKey],
                ["fixture.update.other", otherKey],
            ]) {
                await database.client.begin(async (transaction) => {
                    await lockQueue(transaction);
                    await enqueueJob(
                        transaction,
                        {
                            ...maintenanceJob(30).definition,
                            key: key!,
                            resourceKeys: [host!],
                        },
                        "system:test",
                        crypto.randomUUID()
                    );
                });
            }
            expect(
                await claimJob(database.client, worker, ["fixture.update.selected"])
            ).toBeUndefined();
            expect(
                await claimJob(database.client, worker, ["fixture.update.other"])
            ).toBeDefined();
            const changed = applicationJobs(
                [{ ...docker.target, endpoint: other.endpoint }],
                database.client
            ).find((handler) => handler.definition.key === "applications.restart")!;
            await expectOperationFailure(
                changed.execute(lifecycle.payload, {
                    runId: lifecycle.id,
                    leaseToken: lifecycle.lease_token,
                    signal: AbortSignal.timeout(3000),
                    reportProgress: () => Promise.resolve(),
                    commit: () => Promise.resolve(false),
                }),
                "target changed"
            );
            expect(docker.calls).toEqual([]);
        } finally {
            await docker.close();
            await database.close();
        }
    }
);

test("snapshot admission and reported freshness use database time, not serialized worker timestamps", async () => {
    const database = await operationFixture(),
        docker = createApplicationFixture();
    try {
        const operations = {
            ...database,
            applicationTargets: [docker.target],
            registry: createJobRegistry(
                applicationJobs([docker.target], database.client)
            ),
        };
        const inventory = await collectApplications(
            [docker.target],
            (target) => createDockerPort(target, {}),
            AbortSignal.timeout(3000)
        );
        const application = inventory.hosts[0]?.applications[0];
        if (!application) throw new Error("Missing fixture application");
        const principal = { kind: "human" as const, id: "operator", capabilities };
        const caller = appRouter.createCaller({
            operations,
            principal,
            verifyHuman: () => Promise.resolve(principal),
        });
        for (const [ageSeconds, clockOffsetSeconds, fresh] of [
            [-121, 600, false],
            [600, 600, false],
            [0, -600, true],
            [0, 600, true],
        ] as const) {
            const serialized = {
                ...inventory,
                capturedAt: new Date(
                    Date.now() + clockOffsetSeconds * 1000
                ).toISOString(),
            };
            await database.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('applications.inventory',${JSON.stringify(serialized)}::text::jsonb,now()+${ageSeconds}::int*interval '1 second') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,captured_at=EXCLUDED.captured_at`;
            const snapshot = await caller.applications.inventory();
            expect(snapshot.fresh).toBe(fresh);
            expect(snapshot.inventory?.hosts[0]?.applications).toHaveLength(2);
            const input = {
                host: "demo",
                selection: {
                    kind: "container" as const,
                    target: application.containerId,
                },
                revision: application.revision,
                operation: "restart" as const,
                requestId: crypto.randomUUID(),
            };
            if (fresh)
                expect(await caller.applications.request(input)).toHaveProperty("id");
            else
                await expectOperationFailure(caller.applications.request(input), "stale");
        }
        expect(await database.client`SELECT id FROM job_runs`).toHaveLength(2);
        expect(docker.calls).toEqual([]);
    } finally {
        await docker.close();
        await database.close();
    }
});

test("a clock-skewed discovery worker persists freshness using the database timestamp", async () => {
    const database = await operationFixture(),
        docker = createApplicationFixture();
    try {
        // Change only the child worker's clock; parallel suites keep the real clock.
        const worker = Bun.spawn(
            [
                process.execPath,
                "--no-env-file",
                "--eval",
                `
            import { SQL } from "bun";
            import { applicationJobs } from ${JSON.stringify(new URL("../integrations/applications/jobs.ts", import.meta.url).href)};
            const input = await Bun.stdin.json();
            const RealDate = Date;
            globalThis.Date = class extends RealDate {
                constructor(value) { super(value === undefined ? RealDate.now() + 600_000 : value); }
                static now() { return RealDate.now() + 600_000; }
            };
            const client = new SQL(input.url);
            try {
                const handler = applicationJobs([input.target], client).find((entry) => entry.definition.key === "applications.discover");
                await handler.execute({}, { runId: "synthetic", leaseToken: "synthetic",
                    signal: AbortSignal.timeout(3000), reportProgress: async () => {},
                    commit: async (write) => { await client.begin(write); return true; },
                });
            } finally { await client.close(); }
        `,
            ],
            {
                stdin: new Blob([
                    JSON.stringify({ url: database.url, target: docker.target }),
                ]),
                stdout: "pipe",
                stderr: "pipe",
            }
        );
        const [exitCode] = await Promise.all([
            worker.exited,
            new Response(worker.stdout).text(),
            new Response(worker.stderr).text(),
        ]);
        expect(exitCode).toBe(0);
        const [row] = await database.client<
            { databaseFresh: boolean; workerAhead: boolean }[]
        >`
            SELECT captured_at BETWEEN now()-interval '1 minute' AND now() AS "databaseFresh",
            (value->>'capturedAt')::timestamptz > now()+interval '9 minutes' AS "workerAhead"
            FROM operation_snapshots WHERE key='applications.inventory'`;
        expect(row).toEqual({ databaseFresh: true, workerAhead: true });
        const snapshot = await readApplicationInventory(database.client);
        expect(snapshot?.fresh).toBe(true);
        await database.client`UPDATE operation_snapshots SET captured_at=now()-interval '121 seconds' WHERE key='applications.inventory'`;
        const expired = await readApplicationInventory(database.client);
        expect(expired?.fresh).toBe(false);
        expect(docker.calls).toEqual([]);
    } finally {
        await docker.close();
        await database.close();
    }
});

test.each(["start", "stop", "restart"] as const)(
    "%s run titles identify the confirmed selection and survive replay without inventory",
    async (operation) => {
        const database = await operationFixture(),
            docker = createApplicationFixture();
        try {
            const operations = {
                ...database,
                applicationTargets: [docker.target],
                registry: createJobRegistry(
                    applicationJobs([docker.target], database.client, (target) =>
                        createDockerPort(target, {})
                    )
                ),
            };
            const inventory = await collectApplications(
                [docker.target],
                (target) => createDockerPort(target, {}),
                AbortSignal.timeout(2000)
            );
            const applications = inventory.hosts[0]?.applications ?? [];
            const application = applications[0];
            if (!application) throw new Error("Missing fixture application");
            const principal = { kind: "human" as const, id: "operator", capabilities };
            const caller = appRouter.createCaller({
                operations,
                principal,
                verifyHuman: () => Promise.resolve(principal),
            });
            const verb = { start: "Start", stop: "Stop", restart: "Restart" }[operation];
            for (const selection of [
                { kind: "container" as const, target: application.containerId },
                { kind: "project" as const, target: "demo" },
            ]) {
                await database.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('applications.inventory',${JSON.stringify(inventory)}::text::jsonb,now())`;
                const input = {
                    host: "demo",
                    selection,
                    operation,
                    requestId: crypto.randomUUID(),
                    revision: selectionRevision(
                        selection.kind === "project" ? applications : [application],
                        selection
                    ),
                };
                const result = await caller.applications.request(input);
                const label = `${verb} ${selection.kind === "project" ? "demo" : application.name}`;
                const accepted = await caller.jobs.detail({ id: result.id });
                expect(accepted.run.label).toBe(label);
                await database.client`DELETE FROM operation_snapshots WHERE key='applications.inventory'`;
                expect(await caller.applications.request(input)).toEqual(result);
                const replay = await caller.jobs.detail({ id: result.id });
                expect(replay.run.label).toBe(label);
            }
            expect(docker.calls).toEqual([]);
        } finally {
            await database.close();
            await docker.close();
        }
    }
);

test("the synthetic lifecycle reports dependency and health progress, including deterministic failure", async () => {
    const fixture = createApplicationFixture({
        actionDelayMs: 5,
        healthDelayMs: 20,
        includeFailure: true,
    });
    const port = createDockerPort(fixture.target, {});
    const messages: string[] = [];
    const report = (message: string) => {
        messages.push(message);
        return Promise.resolve();
    };
    const signal = AbortSignal.timeout(5000);
    try {
        const inventory = await collectApplications([fixture.target], () => port, signal);
        const revision = selectionRevision(
            inventory.hosts[0]?.applications.filter((item) => item.project === "demo") ??
                [],
            { kind: "project", target: "demo" }
        );
        await performApplicationAction(
            fixture.target,
            port,
            {
                selection: { kind: "project", target: "demo" },
                revision,
                operation: "restart",
            },
            signal,
            report
        );
        expect(fixture.calls).toEqual([
            "stop:web",
            "stop:database",
            "start:database",
            "start:web",
        ]);
        expect(messages.indexOf("Stopping demo-web.")).toBeLessThan(
            messages.indexOf("Starting demo-database.")
        );
        expect(messages).toContain("Waiting for demo-database to become healthy.");
        expect(messages.at(-1)).toBe(
            "All selected containers reached the requested state."
        );
        const failure = inventory.hosts[0]?.applications.find(
            (item) => item.containerId === "d".repeat(64)
        );
        if (!failure) throw new Error("Missing synthetic failure container");
        await expectOperationFailure(
            performApplicationAction(
                fixture.target,
                port,
                {
                    selection: { kind: "container", target: failure.containerId },
                    revision: failure.revision,
                    operation: "start",
                },
                signal,
                report
            ),
            "ready state"
        );
    } finally {
        await fixture.close();
    }
});

test("application admissions require scoped permissions, recent human proof and exact observed revisions", async () => {
    const database = await operationFixture(),
        docker = createApplicationFixture();
    try {
        const handlers = applicationJobs([docker.target], database.client, (target) =>
            createDockerPort(target, {})
        );
        const operations = {
            ...database,
            applicationTargets: [docker.target],
            registry: createJobRegistry(handlers),
        };
        const inventory = await collectApplications(
            [docker.target],
            (target) => createDockerPort(target, {}),
            AbortSignal.timeout(2000)
        );
        await database.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('applications.inventory',${JSON.stringify(inventory)}::text::jsonb,now())`;
        const principal = { kind: "human" as const, id: "operator", capabilities };
        let proofs = 0;
        const caller = appRouter.createCaller({
            operations,
            principal,
            verifyHuman: () => {
                proofs += 1;
                return Promise.resolve(principal);
            },
        });
        const application = inventory.hosts[0]?.applications[0];
        if (!application) throw new Error("Missing fixture application");
        const input = {
            host: "demo",
            selection: { kind: "container" as const, target: application.containerId },
            revision: application.revision,
            operation: "restart" as const,
            requestId: crypto.randomUUID(),
        };
        await expectOperationFailure(
            appRouter.createCaller({ operations, principal }).applications.request(input),
            "verification"
        );
        await expectOperationFailure(
            appRouter
                .createCaller({
                    operations,
                    principal: {
                        kind: "automation",
                        id: "bot",
                        capabilities: ["jobs:run"],
                    },
                })
                .applications.request(input),
            "permission"
        );
        await expectOperationFailure(
            appRouter
                .createCaller({
                    operations,
                    principal,
                    verifyHuman: () => Promise.resolve({ ...principal, id: "other" }),
                })
                .applications.request(input),
            "changed"
        );
        await expectOperationFailure(
            caller.jobs.run({
                action: "applications.restart",
                requestId: crypto.randomUUID(),
                payload: {},
            }),
            "confirmation"
        );
        await expectOperationFailure(
            caller.applications.request({ ...input, revision: "0".repeat(64) }),
            "changed"
        );
        const changed = docker.containers.get(application.containerId);
        if (!changed) throw new Error("Missing fixture container");
        const originalHealth = changed.State.Health;
        changed.State.Health = { Status: "unhealthy" };
        const changedInventory = await collectApplications(
            [docker.target],
            (target) => createDockerPort(target, {}),
            AbortSignal.timeout(2000)
        );
        await database.client`UPDATE operation_snapshots SET value=${JSON.stringify(changedInventory)}::text::jsonb WHERE key='applications.inventory'`;
        await expectOperationFailure(caller.applications.request(input), "changed");
        expect(await database.client`SELECT id FROM job_runs`).toHaveLength(0);
        changed.State.Health = originalHealth;
        await database.client`UPDATE operation_snapshots SET value=${JSON.stringify(inventory)}::text::jsonb WHERE key='applications.inventory'`;
        const first = await caller.applications.request(input);
        expect(await caller.applications.request(input)).toEqual(first);
        expect(proofs).toBeGreaterThan(1);
        expect(await database.client`SELECT id FROM job_runs`).toHaveLength(1);
        await expectOperationFailure(
            caller.applications.request({ ...input, operation: "stop" }),
            "different"
        );
        expect(docker.calls).toEqual([]);
        const handler = operations.registry.get("applications.restart");
        if (!handler) throw new Error("Missing restart handler");
        const { requestId: _requestId, ...payload } = input;
        const commit = (
            write: Parameters<Parameters<typeof handler.execute>[1]["commit"]>[0]
        ) =>
            database.client.begin(async (transaction) => {
                await write(transaction);
                return true;
            });
        const context = {
            signal: AbortSignal.timeout(3000),
            runId: first.id,
            leaseToken: crypto.randomUUID(),
            reportProgress: async (_message: string) => {},
            commit,
        };
        await handler.execute(payload, context);
        expect(docker.calls).toEqual(["restart:database"]);
        await database.client`UPDATE job_runs SET created_at=now()-interval '3 minutes' WHERE id=${first.id}`;
        await expectOperationFailure(handler.execute(payload, context), "expired");
        expect(docker.calls).toHaveLength(1);
        // Skew only the synthetic worker process, not the shared parallel test runtime.
        const worker = Bun.spawn(
            [
                process.execPath,
                "--no-env-file",
                "--eval",
                `
            import { SQL } from "bun";
            import { applicationJobs } from ${JSON.stringify(new URL("../integrations/applications/jobs.ts", import.meta.url).href)};
            const input = await Bun.stdin.json();
            const realNow = Date.now;
            Date.now = () => realNow() - 600_000;
            const client = new SQL(input.url);
            try {
                const handler = applicationJobs([input.target], client).find((entry) => entry.definition.key === "applications.restart");
                await handler.execute(input.payload, {
                    runId: input.id, leaseToken: "synthetic", signal: AbortSignal.timeout(3000),
                    reportProgress: async () => {},
                    commit: async (write) => { await client.begin(write); return true; },
                });
                process.exitCode = 1;
            } catch (error) {
                if (error instanceof Error && error.message === "Application authorization expired or target changed")
                    console.info("Expired using database time");
                else process.exitCode = 1;
            } finally { await client.close(); }
        `,
            ],
            {
                stdin: new Blob([
                    JSON.stringify({
                        url: database.url,
                        target: docker.target,
                        payload,
                        id: first.id,
                    }),
                ]),
                stdout: "pipe",
                stderr: "pipe",
            }
        );
        const [exitCode, output] = await Promise.all([
            worker.exited,
            new Response(worker.stdout).text(),
            new Response(worker.stderr).text(),
        ]);
        expect(exitCode).toBe(0);
        expect(output.trim()).toBe("Expired using database time");
        expect(docker.calls).toHaveLength(1);
        expect(handler.definition).toMatchObject({
            retrySafe: false,
            attemptLimit: 1,
            intervalSeconds: null,
            admission: "integration",
        });
        const reduced = appRouter.createCaller({
            operations: {
                ...operations,
                applicationTargets: [{ ...docker.target, projects: ["other"] }],
            },
            principal,
        });
        const reducedInventory = await reduced.applications.inventory();
        expect(reducedInventory.inventory?.hosts[0]?.applications).toEqual([]);
    } finally {
        await docker.close();
        await database.close();
    }
});

test("application logs use exact configured container selectors and reject unregistered targets", async () => {
    const database = await operationFixture(),
        docker = createApplicationFixture();
    try {
        const inventory = await collectApplications(
            [docker.target],
            (target) => createDockerPort(target, {}),
            AbortSignal.timeout(2000)
        );
        await database.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('applications.inventory',${JSON.stringify(inventory)}::text::jsonb,now())`;
        const operations = {
            ...database,
            applicationTargets: [docker.target],
            logs: { url: docker.url, token: undefined },
        };
        const principal = {
            kind: "automation" as const,
            id: "reader",
            capabilities: ["applications:logs" as const],
        };
        const caller = appRouter.createCaller({ operations, principal });
        const input = { host: "demo", container: "b".repeat(64), range: "1h" as const };
        const page = await caller.applications.logs(input);
        expect(page.entries.length).toBeGreaterThan(0);
        expect(docker.queries[0]).toBe('{host="demo",service="demo-web"}');
        await expectOperationFailure(
            caller.applications.logs({ ...input, container: "f".repeat(64) }),
            "inventory"
        );
        await expectOperationFailure(
            caller.applications.logs({ ...input, host: "unknown" }),
            "configured"
        );
        await expectOperationFailure(
            appRouter
                .createCaller({
                    operations,
                    principal: { ...principal, capabilities: [] },
                })
                .applications.logs(input),
            "permission"
        );
        expect(docker.calls).toEqual([]);
    } finally {
        await docker.close();
        await database.close();
    }
});
