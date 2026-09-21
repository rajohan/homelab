import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import type { UpdateReport } from "@homelab/contracts/updates";

import { appRouter } from "../api/router";
import { createAutomation } from "../automation/service";
import { startDashboardServer } from "../index";
import { updatesJob } from "../integrations/updates/job";
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
                    commit: async (write) => {
                        await (change === "publication"
                            ? fixture.client`UPDATE operation_snapshots SET value = jsonb_set(value, '{capturedAt}', to_jsonb(${new Date(Date.now() + 1000).toISOString()}::text)) WHERE key = 'updates:demo'`
                            : fixture.client`UPDATE operation_snapshots SET value = jsonb_set(value, '{items,0,installed}', '"1.1-1"') WHERE key = 'updates:demo'`);
                        await fixture.client.begin(write);
                        return true;
                    },
                }
            );
            expect(
                await fixture.client`SELECT key FROM operation_snapshots WHERE key = 'updates.resolved:demo'`
            ).toHaveLength(0);
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
