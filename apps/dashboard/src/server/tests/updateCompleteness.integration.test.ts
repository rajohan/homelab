import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import type { TableCursor } from "@homelab/contracts/tableSort";
import type { UpdateReport } from "@homelab/contracts/updates";

import { appRouter } from "../api/router";
import { updateActionJobs } from "../integrations/updates/actions";
import { applyUpdate } from "../integrations/updates/apply";
import { readUpdateReport, freshAptObservation } from "../integrations/updates/inventory";
import { updatesJob } from "../integrations/updates/job";
import { writeUpdatePolicy } from "../integrations/updates/policies";
import { claimJob, commitClaim, settleClaim } from "../jobs/claims";
import { enqueueJob, lockQueue } from "../jobs/queue";
import { createJobRegistry } from "../jobs/registry";
import { operationFixture } from "../testing/operations";
import {
    previewUpdateItems,
    previewUpdateTargets,
    previewUpdateJobs,
} from "../testing/updates";

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

test.each(["single", "host", "all", "automatic"] as const)(
    "disposable preview prepares APT observations through the %s path",
    async (path) => {
        const fixture = await operationFixture();
        const sources = ["demo-main", "demo-sentinel"].map((id) => ({
            id,
            label: id,
            publisher: id,
        }));
        const registry = createJobRegistry(
            previewUpdateJobs(
                createJobRegistry([
                    updatesJob(sources, fixture.client, fetch, previewUpdateTargets),
                ]),
                fixture.client
            )
        );
        const principal = { kind: "human" as const, id: "operator", capabilities };
        const caller = appRouter.createCaller({
            operations: {
                ...fixture,
                registry,
                updateSources: sources,
                updateTargets: previewUpdateTargets,
            },
            principal,
            verifyHuman: () => Promise.resolve(principal),
        });
        const observed: UpdateReport = {
            capturedAt: new Date(Date.now() - 8 * 3_600_000).toISOString(),
            repositoryMetadataAt: new Date().toISOString(),
            complete: true,
            coveredKinds: ["os"],
            items: [
                {
                    id: "apt:example",
                    name: "example",
                    kind: "os",
                    installed: "1.0.0",
                    available: "1.1.0",
                    status: "available",
                    held: false,
                    security: false,
                },
            ],
        };
        try {
            for (const source of sources)
                await fixture.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES (${`updates:${source.id}`},${JSON.stringify(observed)}::text::jsonb,now())`;
            const worker = await fixture.registerWorker();
            const run = async (action: string) => {
                const claim = await claimJob(fixture.client, worker, [action]);
                if (!claim) throw new Error("Missing preview preparation job");
                await registry.get(action)!.execute(claim.payload, {
                    runId: claim.id,
                    leaseToken: claim.lease_token,
                    signal: AbortSignal.timeout(5000),
                    reportProgress: () => Promise.resolve(),
                    commit: (write, queue) =>
                        commitClaim(fixture.client, claim, write, queue),
                });
                await settleClaim(fixture.client, claim, "succeeded");
            };
            if (path === "automatic") {
                for (const target of previewUpdateTargets.filter(
                    (target) => target.driver.kind === "apt"
                ))
                    await writeUpdatePolicy(fixture.client, target, "human:operator", {
                        version: 0,
                        enabled: true,
                    });
                await fixture.client.begin(async (transaction) => {
                    await lockQueue(transaction);
                    await enqueueJob(
                        transaction,
                        registry.get("updates.automatic")!.definition,
                        "system:test",
                        crypto.randomUUID()
                    );
                });
                await run("updates.automatic");
            } else {
                const preparation: { source?: string; target?: string } = {};
                if (path === "single") preparation.target = "demo-packages";
                if (path === "host") preparation.source = "demo-main";
                await caller.updates.prepare({
                    requestId: crypto.randomUUID(),
                    ...preparation,
                });
                await run("updates.releases");
                if (path === "single") {
                    const plan = await caller.updates.plan({
                        target: "demo-packages",
                        item: "apt:example",
                    });
                    expect(plan.control.allowed).toBe(true);
                    await caller.updates.request({
                        target: "demo-packages",
                        item: "apt:example",
                        revision: plan.control.revision,
                        requestId: crypto.randomUUID(),
                    });
                } else {
                    const scope = path === "host" ? { source: "demo-main" } : {};
                    const plan = await caller.updates.batchPlan(scope);
                    await caller.updates.batchRequest({
                        ...scope,
                        revision: plan.revision,
                        requestId: crypto.randomUUID(),
                    });
                }
            }
            const main = (await readUpdateReport(fixture.client, "demo-main"))!;
            const sentinel = (await readUpdateReport(fixture.client, "demo-sentinel"))!;
            expect(freshAptObservation(main)).toBe(true);
            expect(freshAptObservation(sentinel)).toBe(
                path === "all" || path === "automatic"
            );
            expect(main.items).toEqual(observed.items);
            expect(
                await fixture.client`SELECT id FROM job_runs WHERE state='queued'`
            ).toHaveLength(path === "all" || path === "automatic" ? 2 : 1);
        } finally {
            await fixture.close();
        }
    }
);
