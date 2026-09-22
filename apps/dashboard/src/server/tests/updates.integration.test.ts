import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import type { UpdateReport } from "@homelab/contracts/updates";

import { appRouter } from "../api/router";
import { createAutomation } from "../automation/service";
import { startDashboardServer } from "../index";
import { readUpdateReport } from "../integrations/updates/inventory";
import { updatesJob } from "../integrations/updates/job";
import { claimJob, commitClaim, settleClaim } from "../jobs/claims";
import { lockQueue } from "../jobs/queue";
import { createJobRegistry } from "../jobs/registry";
import type { ClaimedJob } from "../jobs/types";
import { operationFixture, expectOperationFailure } from "../testing/operations";

function report(): UpdateReport {
    return {
        capturedAt: new Date().toISOString(),
        repositoryMetadataAt: new Date().toISOString(),
        complete: true,
        coveredKinds: ["os"],
        items: [
            {
                id: "apt:example",
                name: "example",
                kind: "os",
                installed: "1.0-1",
                available: "1.1-1",
                status: "available",
                security: true,
                held: false,
            },
        ],
    };
}

test.each(["sized", "chunked"] as const)(
    "real HTTP update reports respect route byte budgets with %s bodies",
    async (transport) => {
        const fixture = await operationFixture();
        const publisher = await createAutomation(fixture.client, "human:test", {
            label: "Publisher",
            capabilities: ["updates:publish"],
            expiresAt: null,
        });
        const unrelated = await createAutomation(fixture.client, "human:test", {
            label: "Unregistered",
            capabilities: ["updates:publish"],
            expiresAt: null,
        });
        const reader = await createAutomation(fixture.client, "human:test", {
            label: "Reader",
            capabilities: ["updates:read"],
            expiresAt: null,
        });
        const server = startDashboardServer({
            hostname: "127.0.0.1",
            port: 0,
            development: false,
            authentication: null,
            operations: {
                databaseUrl: fixture.url,
                metricsUrl: undefined,
                metricsToken: undefined,
                concurrency: 1,
                retentionDays: 30,
                updateSources: [{ id: "demo", label: "Demo", publisher: publisher.id }],
            },
        });
        const observation = report();
        const template = observation.items[0];
        if (!template) throw new Error("Missing synthetic package");
        observation.items = Array.from({ length: 1500 }, (_, index) => ({
            ...template,
            id: `apt:package-${index}`,
            name: `påckage-${index}`,
        }));
        const serialized = JSON.stringify({ json: observation });
        const bytes = (size: number) =>
            new TextEncoder().encode(
                serialized +
                    " ".repeat(size - new TextEncoder().encode(serialized).byteLength)
            );
        const send = (
            body: Uint8Array,
            path = "/api/automation/updates.publish",
            token = publisher.token,
            extraHeaders: Record<string, string> = {}
        ) =>
            fetch(new URL(path, server.url), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                    ...extraHeaders,
                },
                body:
                    transport === "sized"
                        ? body
                        : new ReadableStream({
                              start(controller) {
                                  for (
                                      let offset = 0;
                                      offset < body.byteLength;
                                      offset += 16_384
                                  )
                                      controller.enqueue(
                                          body.subarray(offset, offset + 16_384)
                                      );
                                  controller.close();
                              },
                          }),
            });
        try {
            const accepted = await send(bytes(950_000));
            expect(accepted.status).toBe(200);
            expect(await accepted.json()).toMatchObject({
                result: { data: { json: { accepted: true } } },
            });
            for (const path of [
                "/api/automation/updates.publish",
                "/api/automation/updates.publish,updates.publish",
                "/api/trpc/updates.publish",
                "/api/account/email",
            ]) {
                const rejected = await send(
                    bytes(path === "/api/automation/updates.publish" ? 950_001 : 950_000),
                    path
                );
                expect(rejected.status).toBe(413);
                expect(rejected.headers.get("cache-control")).toBe("no-store");
                expect(await rejected.json()).toMatchObject({
                    code: "PAYLOAD_TOO_LARGE",
                });
            }
            for (const [token, expected] of [
                ["invalid", 401],
                [unrelated.token, 403],
                [reader.token, 403],
            ] as const) {
                const denied = await send(bytes(950_000), undefined, token);
                expect(denied.status).toBe(expected);
                await denied.body?.cancel();
            }
            for (const headers of [
                { Cookie: "browser=1" },
                { Origin: String(server.url) },
            ]) {
                const denied = await send(bytes(950_000), undefined, undefined, headers);
                expect(denied.status).toBe(403);
                await denied.body?.cancel();
            }
            for (const size of [65_536, 65_537]) {
                const ordinary = await send(
                    new TextEncoder().encode(" ".repeat(size)),
                    "/api/automation/system.status",
                    "invalid"
                );
                expect(ordinary.status).toBe(size === 65_536 ? 401 : 413);
                await ordinary.body?.cancel();
            }
            const rows = await fixture.client<
                { count: number }[]
            >`SELECT jsonb_array_length(value->'items')::int AS count FROM operation_snapshots WHERE key = 'updates:demo'`;
            expect(rows).toEqual([{ count: 1500 }]);
            expect(
                await fixture.client<
                    { action: string; state: string }[]
                >`SELECT action,state FROM job_runs`
            ).toEqual([{ action: "updates.releases", state: "queued" }]);
        } finally {
            await server.stop(true);
            await fixture.close();
        }
    }
);

test("update publishers are source-bound, monotonic and distinct from human readers", async () => {
    const fixture = await operationFixture();
    const publisher = crypto.randomUUID();
    const updateSources = [{ id: "demo", label: "Demo", publisher }];
    const operations = { ...fixture, updateSources };
    const machine = appRouter.createCaller({
        operations,
        principal: {
            kind: "automation",
            id: publisher,
            capabilities: ["updates:publish"],
        },
    });
    const human = appRouter.createCaller({
        operations,
        principal: { kind: "human", id: "operator", capabilities },
    });
    try {
        const observation1 = await human.updates.inventory();
        expect(observation1[0]).toMatchObject({ stale: true, report: null });
        await expectOperationFailure(
            human.updates.publish(report()),
            "automation account"
        );
        await expectOperationFailure(
            appRouter
                .createCaller({
                    operations,
                    principal: {
                        kind: "automation",
                        id: "other",
                        capabilities: ["updates:publish"],
                    },
                })
                .updates.publish(report()),
            "not registered"
        );
        await expectOperationFailure(machine.updates.inventory(), "permission");
        const current = report();
        expect(await machine.updates.publish(current)).toEqual({ accepted: true });
        expect(await machine.updates.publish(current)).toEqual({ accepted: false });
        const observation2 = await human.updates.inventory();
        expect(observation2[0]).toMatchObject({
            stale: false,
            report: { available: 1, security: 1, total: 1 },
        });
        expect(observation2[0]?.report).not.toHaveProperty("items");
        const items = await human.updates.list({ source: "demo" });
        expect(items.items).toMatchObject([{ name: "example", installed: "1.0-1" }]);
        await expectOperationFailure(
            human.updates.list({ source: "other" }),
            "not configured"
        );
        await expectOperationFailure(
            machine.updates.publish({
                ...current,
                capturedAt: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            "invalid"
        );
        await expectOperationFailure(
            machine.updates.publish({
                ...current,
                items: [...current.items, ...current.items],
            }),
            "invalid"
        );
        await expectOperationFailure(
            machine.updates.publish({ ...current, coveredKinds: ["container"] }),
            "invalid"
        );
        await fixture.client`UPDATE operation_snapshots SET captured_at = now() - interval '27 hours' WHERE key = 'updates:demo'`;
        const observation3 = await human.updates.inventory();
        expect(observation3[0]?.stale).toBe(true);
        expect(
            await appRouter
                .createCaller({
                    operations: { ...operations, updateSources: [] },
                    principal: { kind: "human", id: "operator", capabilities },
                })
                .updates.inventory()
        ).toEqual([]);
    } finally {
        await fixture.close();
    }
});

test("accepted publications coalesce read-only checks and retain an in-flight follow-up", async () => {
    const fixture = await operationFixture();
    const sources = ["alpha", "beta"].map((id) => ({
        id,
        label: id,
        publisher: crypto.randomUUID(),
    }));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let requests = 0;
    let executing: Promise<void> | undefined;
    const feed = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => Response.json({ version: "1.1.0" }),
    });
    const request: typeof fetch = Object.assign(
        async (
            input: Parameters<typeof fetch>[0],
            options?: Parameters<typeof fetch>[1]
        ) => {
            expect(new URL(input instanceof Request ? input.url : input).href).toBe(
                "https://registry.npmjs.org/openclaw/latest"
            );
            if (++requests === 1) {
                started.resolve();
                await release.promise;
            }
            return fetch(feed.url, options);
        },
        { preconnect: fetch.preconnect }
    );
    const handler = updatesJob(sources, fixture.client, request);
    const registry = createJobRegistry([handler]);
    const machines = sources.map((source) =>
        appRouter.createCaller({
            operations: { ...fixture, registry, updateSources: sources },
            principal: {
                kind: "automation",
                id: source.publisher,
                capabilities: ["updates:publish"],
            },
        })
    );
    const capturedAt = Date.now() - 20_000;
    const observation = (offset: number): UpdateReport => ({
        ...report(),
        capturedAt: new Date(capturedAt + offset).toISOString(),
        coveredKinds: ["application"],
        items: [
            {
                id: "native:openclaw",
                name: "OpenClaw",
                kind: "application",
                release: "openclaw",
                installed: "1.0.0",
                available: null,
                status: "unknown",
                security: false,
                held: false,
            },
        ],
    });
    const run = (claim: ClaimedJob) =>
        handler.execute(claim.payload, {
            runId: claim.id,
            leaseToken: claim.lease_token,
            signal: AbortSignal.timeout(5000),
            reportProgress: () => Promise.resolve(),
            commit: (write, queue) => commitClaim(fixture.client, claim, write, queue),
        });
    try {
        const first = observation(0);
        expect(await machines[0]!.updates.publish(first)).toEqual({ accepted: true });
        expect(await machines[0]!.updates.publish(first)).toEqual({ accepted: false });
        expect(
            await machines[0]!.updates.publish({
                ...first,
                capturedAt: new Date(Date.parse(first.capturedAt) - 1).toISOString(),
            })
        ).toEqual({ accepted: false });
        await Promise.all(
            machines.map((machine) => machine.updates.publish(observation(1000)))
        );
        expect(
            await fixture.client<
                {
                    action: string;
                    state: string;
                    requested_by: string;
                    payload: Record<string, unknown>;
                }[]
            >`SELECT action,state,requested_by,payload FROM job_runs`
        ).toEqual([
            {
                action: "updates.releases",
                state: "queued",
                requested_by: "system:updates",
                payload: {},
            },
        ]);
        const worker = await fixture.registerWorker();
        const current = (await claimJob(fixture.client, worker, [
            handler.definition.key,
        ]))!;
        executing = run(current);
        await started.promise;
        const newest = observation(2000);
        await Promise.all(machines.map((machine) => machine.updates.publish(newest)));
        expect(
            await fixture.client<
                { state: string }[]
            >`SELECT state FROM job_runs ORDER BY id`
        ).toEqual([{ state: "running" }, { state: "queued" }]);
        expect(
            await claimJob(fixture.client, worker, [handler.definition.key])
        ).toBeUndefined();
        release.resolve();
        await executing;
        // The running check read alpha before publication and must not publish its old result.
        const pending = await readUpdateReport(fixture.client, "alpha");
        expect(pending?.checkedAt).toBeNull();
        await settleClaim(fixture.client, current, "succeeded");
        const following = (await claimJob(fixture.client, worker, [
            handler.definition.key,
        ]))!;
        await run(following);
        await settleClaim(fixture.client, following, "succeeded");
        for (const source of sources) {
            const checked = await readUpdateReport(fixture.client, source.id);
            expect(checked?.capturedAt).toBe(newest.capturedAt);
            expect(checked?.checkedAt).not.toBeNull();
            expect(checked?.items[0]).toMatchObject({
                status: "available",
                available: "1.1.0",
                candidateVerified: true,
            });
        }
        expect(
            await fixture.client<
                { action: string; state: string }[]
            >`SELECT action,state FROM job_runs ORDER BY id`
        ).toEqual([
            { action: "updates.releases", state: "succeeded" },
            { action: "updates.releases", state: "succeeded" },
        ]);
        expect(requests).toBe(2);
    } finally {
        release.resolve();
        await executing?.catch(() => {});
        await feed.stop(true);
        await fixture.close();
    }
});

test("publication-triggered checks respect disabled schedules, worker pause and queue admission", async () => {
    const fixture = await operationFixture();
    const source = { id: "demo", label: "Demo", publisher: crypto.randomUUID() };
    const handler = updatesJob([source], fixture.client);
    const machine = appRouter.createCaller({
        operations: {
            ...fixture,
            registry: createJobRegistry([handler]),
            updateSources: [source],
        },
        principal: {
            kind: "automation",
            id: source.publisher,
            capabilities: ["updates:publish"],
        },
    });
    const first = {
        ...report(),
        capturedAt: new Date(Date.now() - 10_000).toISOString(),
    };
    try {
        await fixture.client`INSERT INTO job_schedules(id,action,enabled,schedule,disable_reason,next_run_at) VALUES (${crypto.randomUUID()},'updates.releases',false,'{"kind":"interval","intervalSeconds":3600}','Operator paused checks',now()+interval '1 hour')`;
        expect(await machine.updates.publish(first)).toEqual({ accepted: true });
        expect(await fixture.client`SELECT id FROM job_runs`).toHaveLength(0);
        await fixture.client`UPDATE job_schedules SET enabled=true,disable_reason=NULL`;
        await fixture.client`INSERT INTO worker_control(id,paused) VALUES(1,true) ON CONFLICT(id) DO UPDATE SET paused=true`;
        const second = {
            ...first,
            capturedAt: new Date(Date.now() - 5000).toISOString(),
        };
        expect(await machine.updates.publish(second)).toEqual({ accepted: true });
        const worker = await fixture.registerWorker();
        expect(
            await claimJob(fixture.client, worker, [handler.definition.key])
        ).toBeUndefined();
        expect(
            await fixture.client<{ state: string }[]>`SELECT state FROM job_runs`
        ).toEqual([{ state: "queued" }]);
        // Fill the existing bounded queue with unrelated synthetic jobs; publication
        // and its required check must fail atomically, without replacing the report.
        await fixture.client`UPDATE job_runs SET action='fixture.other'`;
        await fixture.client`INSERT INTO job_runs(id,action,label,resource_class,state,payload,fingerprint,idempotency_key,requested_by,attempt_limit,retry_safe,timeout_ms,resource_keys)
            SELECT gen_random_uuid(),action,label,resource_class,state,payload,fingerprint,'fixture-full:' || n,requested_by,attempt_limit,retry_safe,timeout_ms,resource_keys FROM job_runs CROSS JOIN generate_series(1,999) n`;
        await expectOperationFailure(machine.updates.publish(report()), "queue is full");
        const retained = await readUpdateReport(fixture.client, source.id);
        expect(retained?.capturedAt).toBe(second.capturedAt);
        expect(
            await fixture.client`SELECT id FROM job_runs WHERE action='updates.releases'`
        ).toHaveLength(0);
    } finally {
        await fixture.close();
    }
});

test.each(["publication", "receipt"] as const)(
    "update resolution cannot overwrite a newer local %s",
    async (change) => {
        const fixture = await operationFixture();
        const sources = [{ id: "demo", label: "Demo", publisher: crypto.randomUUID() }];
        const value = report();
        const handler = updatesJob(sources, fixture.client);
        try {
            await fixture.client`INSERT INTO operation_snapshots (key, value, captured_at) VALUES ('updates:demo', ${JSON.stringify(value)}::text::jsonb, now())`;
            await handler.execute(
                {},
                {
                    runId: crypto.randomUUID(),
                    leaseToken: crypto.randomUUID(),
                    signal: AbortSignal.timeout(5000),
                    reportProgress: () => Promise.resolve(),
                    commit: async (write, queue) => {
                        await (change === "publication"
                            ? fixture.client`UPDATE operation_snapshots SET value = jsonb_set(value, '{capturedAt}', to_jsonb(${new Date(Date.now() + 1000).toISOString()}::text)) WHERE key = 'updates:demo'`
                            : fixture.client`UPDATE operation_snapshots SET value = jsonb_set(value, '{items,0,installed}', '"1.1-1"') WHERE key = 'updates:demo'`);
                        expect(queue).toBe(true);
                        await fixture.client.begin(async (transaction) => {
                            await lockQueue(transaction);
                            await write(transaction);
                        });
                        return true;
                    },
                }
            );
            expect(
                await fixture.client`SELECT key FROM operation_snapshots WHERE key = 'updates.resolved:demo'`
            ).toHaveLength(0);
            expect(
                await fixture.client<
                    { action: string; state: string }[]
                >`SELECT action,state FROM job_runs`
            ).toEqual([{ action: "updates.releases", state: "queued" }]);
            await handler.execute(
                {},
                {
                    runId: crypto.randomUUID(),
                    leaseToken: crypto.randomUUID(),
                    signal: AbortSignal.timeout(5000),
                    reportProgress: () => Promise.resolve(),
                    commit: async (write) => {
                        await fixture.client.begin(write);
                        return true;
                    },
                }
            );
            expect(
                await fixture.client`SELECT key FROM operation_snapshots WHERE key = 'updates.resolved:demo'`
            ).toHaveLength(1);
            await expectOperationFailure(
                handler.execute(
                    {},
                    {
                        runId: crypto.randomUUID(),
                        leaseToken: crypto.randomUUID(),
                        signal: AbortSignal.timeout(5000),
                        reportProgress: () => Promise.resolve(),
                        commit: () => Promise.resolve(false),
                    }
                ),
                "ownership"
            );
        } finally {
            await fixture.close();
        }
    }
);
