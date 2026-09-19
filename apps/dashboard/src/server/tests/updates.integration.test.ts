import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import type { UpdateReport } from "@homelab/contracts/updates";

import { appRouter } from "../api/router";
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

test("update resolution cannot overwrite a newer local observation", async () => {
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
                    await fixture.client`UPDATE operation_snapshots SET value = jsonb_set(value, '{capturedAt}', to_jsonb(${new Date(Date.now() + 1000).toISOString()}::text)) WHERE key = 'updates:demo'`;
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
});
