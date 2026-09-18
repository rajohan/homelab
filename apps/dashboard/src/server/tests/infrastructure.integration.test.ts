import { expect, mock, test } from "bun:test";

import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";

import { appRouter } from "../api/router";
import { inventoryQueries } from "../integrations/metrics/catalog";
import { buildHosts } from "../integrations/metrics/hosts";
import { createInventoryReader } from "../integrations/metrics/liveInventory";
import { readSavedInventory } from "../integrations/metrics/snapshot";
import { createOperationsRuntime } from "../operations/runtime";
import { expectOperationFailure, operationFixture } from "../testing/operations";

const metric = (labels: Record<string, string>, value: string) => ({
    metric: labels,
    value: [1, value],
});

test("worker and restarted live runtime retain saved identities through successful API responses with failed scrapes", async () => {
    const fixture = await operationFixture();
    let available = true;
    let deleted = false;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
            const query = new URL(request.url).searchParams.get("query");
            let result = [metric({}, "2")];
            if (Object.values(inventoryQueries).includes(query ?? "")) result = [];
            if (query === inventoryQueries.node)
                result = [
                    metric(
                        {
                            __name__: "up",
                            host: "cluster",
                            instance: "cluster-a",
                            job: "pve",
                        },
                        available ? "1" : "0"
                    ),
                ];
            if (query === inventoryQueries.pve && available && !deleted)
                result = [
                    metric(
                        {
                            __name__: "pve_guest_info",
                            host: "cluster",
                            instance: "cluster-a",
                            id: "qemu/100",
                            name: "guest",
                        },
                        "1"
                    ),
                    metric(
                        { __name__: "pve_up", instance: "cluster-a", id: "qemu/100" },
                        "1"
                    ),
                ];
            return Response.json({
                status: "success",
                data: { resultType: "vector", result },
            });
        },
    });
    const configuration = {
        databaseUrl: fixture.url,
        metricsUrl: `http://127.0.0.1:${server.port}`,
        metricsToken: undefined,
        concurrency: 1,
        retentionDays: 30,
    };
    const worker = createOperationsRuntime(configuration);
    const live = createOperationsRuntime(configuration);
    try {
        const handler = worker.registry.get("infrastructure.metrics");
        if (!handler || !live.readInventory)
            throw new Error("Missing metrics integration");
        const execute = () =>
            handler.execute(
                {},
                {
                    runId: Bun.randomUUIDv7(),
                    leaseToken: Bun.randomUUIDv7(),
                    signal: AbortSignal.timeout(5000),
                    commit: async (write) => {
                        await worker.client.begin(write);
                        return true;
                    },
                }
            );
        await execute();
        const first = await readSavedInventory(fixture.client);
        expect(first?.hosts[0]).toMatchObject({ kind: "vm", state: "healthy" });
        available = false;
        // A new dashboard process must seed retention from PostgreSQL, not an empty in-memory cache.
        const polled = await live.readInventory();
        expect(polled.hosts[0]).toMatchObject({
            id: first?.hosts[0]?.id,
            state: "unknown",
        });
        expect(await readSavedInventory(fixture.client)).toEqual(first);
        await execute();
        const failed = await readSavedInventory(fixture.client);
        expect(failed?.hosts[0]).toMatchObject({
            id: first?.hosts[0]?.id,
            state: "unknown",
        });
        available = true;
        deleted = true;
        await execute();
        const recovered = await readSavedInventory(fixture.client);
        expect(recovered?.hosts).toEqual([]);
    } finally {
        await worker.client.close();
        await live.client.close();
        await server.stop(true);
        await fixture.close();
    }
});

test("authorized readers receive shared live inventory without persisting polling snapshots", async () => {
    const fixture = await operationFixture();
    const inventory: InfrastructureInventory = {
        capturedAt: new Date().toISOString(),
        hosts: [],
        applications: [],
        filesystems: [],
        disks: [],
        networks: [],
        services: [],
        storage: [],
        diskHealth: [],
    };
    const collect = mock(() => Promise.resolve(inventory));
    const operations = { ...fixture, readInventory: createInventoryReader(collect) };
    try {
        const denied = appRouter.createCaller({
            operations,
            principal: { kind: "automation", id: "denied", capabilities: ["jobs:read"] },
        });
        await expectOperationFailure(denied.infrastructure.inventory(), "permission");
        expect(collect).not.toHaveBeenCalled();
        const reader = appRouter.createCaller({
            operations,
            principal: {
                kind: "human",
                id: "operator",
                capabilities: ["infrastructure:read"],
            },
        });
        const results = await Promise.all([
            reader.infrastructure.inventory(),
            reader.infrastructure.inventory(),
        ]);
        expect(results).toEqual([inventory, inventory]);
        expect(collect).toHaveBeenCalledTimes(1);
        const rows = await fixture.client<
            { key: string }[]
        >`SELECT key FROM operation_snapshots WHERE key = 'infrastructure.inventory'`;
        expect(rows).toHaveLength(0);
    } finally {
        await fixture.close();
    }
});

test("infrastructure reads require a live principal and the exact read capability", async () => {
    await expectOperationFailure(
        appRouter.createCaller({}).infrastructure.inventory(),
        "Sign in"
    );
    const fixture = await operationFixture();
    try {
        const denied = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "automation", id: "machine", capabilities: ["jobs:read"] },
        });
        await expectOperationFailure(denied.infrastructure.inventory(), "permission");
        await expectOperationFailure(
            denied.infrastructure.applicationHistory({ id: "app", range: "1h" }),
            "permission"
        );
        const reader = appRouter.createCaller({
            operations: fixture,
            principal: {
                kind: "automation",
                id: "machine",
                capabilities: ["infrastructure:read"],
            },
        });
        expect(await reader.infrastructure.inventory()).toBeNull();
        await expectOperationFailure(
            reader.infrastructure.applicationHistory({ id: "app", range: "1h" }),
            "not been configured"
        );
        await expectOperationFailure(
            reader.infrastructure.history({
                id: "missing",
                range: "1h",
                network: null,
                disk: null,
            }),
            "not been configured"
        );
    } finally {
        await fixture.close();
    }
});

test("historical selection is scoped to saved host resources, never arbitrary queries", async () => {
    const fixture = await operationFixture();
    const host = buildHosts({
        up: [{ labels: { host: "example", job: "node" }, value: 1 }],
    })[0];
    if (!host) throw new Error("Missing fixture host");
    const inventory: InfrastructureInventory = {
        capturedAt: new Date().toISOString(),
        hosts: [host],
        applications: [
            {
                id: "app",
                host: "example",
                project: "tools",
                name: "fixture",
                state: "healthy",
                healthcheck: true,
                restarts: 0,
                startedAt: 1,
            },
        ],
        filesystems: [],
        disks: [],
        networks: [],
        services: [],
        storage: [],
        diskHealth: [],
    };
    const queries: string[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
            queries.push(new URL(request.url).searchParams.get("query") ?? "");
            return Response.json({
                status: "success",
                data: { resultType: "matrix", result: [] },
            });
        },
    });
    try {
        await fixture.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('infrastructure.inventory',${JSON.stringify(inventory)}::text::jsonb,now())`;
        const reader = appRouter.createCaller({
            operations: {
                ...fixture,
                metrics: { url: `http://127.0.0.1:${server.port}`, token: undefined },
            },
            principal: {
                kind: "human",
                id: "operator",
                capabilities: ["infrastructure:read"],
            },
        });
        await expectOperationFailure(
            reader.infrastructure.history({
                id: "not-in-inventory",
                range: "1h",
                network: null,
                disk: null,
            }),
            "latest inventory"
        );
        await expectOperationFailure(
            reader.infrastructure.history({
                id: host.id,
                range: "1h",
                network: "another-host-interface",
                disk: null,
            }),
            "this host"
        );
        const result = await reader.infrastructure.history({
            id: host.id,
            range: "1h",
            network: null,
            disk: null,
        });
        expect(result.cpu[0]?.points).toEqual([]);
        expect(result.memory.map((series) => series.key)).toEqual([
            "memory",
            "memoryCapacity",
        ]);
        expect(result.network).toEqual([]);
        await expectOperationFailure(
            reader.infrastructure.applicationHistory({ id: "foreign", range: "1h" }),
            "latest inventory"
        );
        const before = queries.length;
        const applicationHistory = await reader.infrastructure.applicationHistory({
            id: "app",
            range: "6h",
        });
        expect(applicationHistory.memory).toHaveLength(2);
        expect(applicationHistory.memory[1]?.label).toBe("Capacity");
        const applicationQueries = queries.slice(before);
        expect(applicationQueries).toHaveLength(7);
        expect(
            applicationQueries.every(
                (query) =>
                    query.includes('host="example",project="tools",service="fixture"') &&
                    query.endsWith("[6h:60s]")
            )
        ).toBe(true);
    } finally {
        await server.stop(true);
        await fixture.close();
    }
});
