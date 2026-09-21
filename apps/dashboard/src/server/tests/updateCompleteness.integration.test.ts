import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import type { TableCursor } from "@homelab/contracts/tableSort";
import type { UpdateReport } from "@homelab/contracts/updates";

import { appRouter } from "../api/router";
import { updateActionJobs } from "../integrations/updates/actions";
import { applyUpdate } from "../integrations/updates/apply";
import { readUpdateReport } from "../integrations/updates/inventory";
import { createJobRegistry } from "../jobs/registry";
import { operationFixture } from "../testing/operations";
import { previewUpdateItems, previewUpdateTargets } from "../testing/updates";

test("software and toolchains have separate complete sorted pages, policies and batch admission", async () => {
    const fixture = await operationFixture();
    const targets = previewUpdateTargets;
    const sources = [{ id: "demo-main", label: "Main", publisher: crypto.randomUUID() }];
    const registry = createJobRegistry(
        updateActionJobs(targets, fixture.client, () =>
            Promise.reject(new Error("No installation permitted"))
        )
    );
    const principal = { kind: "human" as const, id: "operator", capabilities };
    const caller = appRouter.createCaller({
        operations: {
            ...fixture,
            registry,
            updateTargets: targets,
            updateSources: sources,
        },
        principal,
        verifyHuman: () => Promise.resolve(principal),
    });
    const report: UpdateReport = {
        capturedAt: new Date().toISOString(),
        repositoryMetadataAt: new Date().toISOString(),
        coveredKinds: ["application", "runtime", "container"],
        complete: true,
        items: [...previewUpdateItems],
    };
    try {
        for (const key of ["updates:demo-main", "updates.resolved:demo-main"])
            await fixture.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES (${key},${JSON.stringify(report)}::text::jsonb,now())`;
        for (const category of ["software", "toolchains"] as const) {
            for (const direction of ["ascending", "descending"] as const) {
                let cursor: TableCursor | undefined;
                const ids: string[] = [];
                for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
                    const page = await caller.updates.list({
                        source: "demo-main",
                        category,
                        sort: { id: "name", direction },
                        cursor,
                        limit: 1,
                    });
                    ids.push(...page.items.map((row) => row.id));
                    if (!page.nextSortCursor) break;
                    cursor = page.nextSortCursor;
                }
                const expected = report.items
                    .filter(
                        (row) => (row.kind === "runtime") === (category === "toolchains")
                    )
                    .toSorted(
                        (a, b) =>
                            a.name.localeCompare(b.name, "en", {
                                numeric: true,
                                sensitivity: "base",
                            }) * (direction === "ascending" ? 1 : -1)
                    )
                    .map((row) => row.id);
                expect(ids).toEqual(expected);
            }
        }
        const plan = await caller.updates.batchPlan({ source: "demo-main" });
        const runtimeEntries = plan.entries.filter(
            (entry) => entry.item.kind === "runtime"
        );
        expect(runtimeEntries).toHaveLength(3);
        expect(
            runtimeEntries.every((entry) => entry.reason?.includes("separate toolchain"))
        ).toBe(true);
        const policies = await caller.updates.policies();
        expect(
            policies.filter((policy) => policy.category === "toolchains")
        ).toHaveLength(3);
        expect(policies.every((policy) => !policy.enabled)).toBe(true);
        const runtimePage = await caller.updates.list({
            source: "demo-main",
            category: "toolchains",
        });
        const runtime = runtimePage.items[0];
        expect(runtime?.control?.allowed).toBe(true);
    } finally {
        await fixture.close();
    }
});

test("a completed installation fences late publisher observations without hiding later reports", async () => {
    const fixture = await operationFixture();
    const target = previewUpdateTargets.find((entry) => entry.id === "demo-bun")!;
    const item = previewUpdateItems.find((entry) => entry.id === "runtime:bun")!;
    const publisher = crypto.randomUUID();
    const machine = appRouter.createCaller({
        operations: {
            ...fixture,
            updateSources: [{ id: target.source, label: "Main", publisher }],
        },
        principal: {
            kind: "automation",
            id: publisher,
            capabilities: ["updates:publish"],
        },
    });
    const before = new Date(Date.now() - 10_000).toISOString();
    const report: UpdateReport = {
        capturedAt: before,
        repositoryMetadataAt: before,
        coveredKinds: ["runtime"],
        complete: true,
        items: [item],
    };
    try {
        expect(await machine.updates.publish(report)).toEqual({ accepted: true });
        await applyUpdate(
            target,
            item,
            false,
            {
                runId: crypto.randomUUID(),
                leaseToken: crypto.randomUUID(),
                signal: AbortSignal.timeout(5000),
                reportProgress: () => Promise.resolve(),
                commit: async (write) => {
                    await fixture.client.begin(write);
                    return true;
                },
            },
            () => Promise.resolve({ installed: item.available!, rebootRequired: true })
        );
        expect(
            await machine.updates.publish({
                ...report,
                capturedAt: new Date(Date.now() - 5000).toISOString(),
            })
        ).toEqual({ accepted: false });
        const installed = await readUpdateReport(fixture.client, target.source);
        expect(installed?.items[0]).toMatchObject({
            installed: item.available,
            status: "current",
        });
        expect(
            await machine.updates.publish({
                ...report,
                capturedAt: new Date(Date.now() + 1).toISOString(),
                items: [{ ...item, installed: item.available!, status: "current" }],
            })
        ).toEqual({ accepted: true });
    } finally {
        await fixture.close();
    }
});
