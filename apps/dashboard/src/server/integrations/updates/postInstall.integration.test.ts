import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import type { UpdateItem, UpdateReport } from "@homelab/contracts/updates";

import { appRouter } from "../../api/router";
import { claimJob, commitClaim, settleClaim } from "../../jobs/claims";
import { createJobRegistry } from "../../jobs/registry";
import { operationFixture } from "../../testing/operations";
import { updateActionJobs } from "./actions";
import { updateBatchKey } from "./batch";
import type { UpdateTarget } from "./configuration";
import { readUpdateReport } from "./inventory";
import { updatesJob } from "./job";
import { updateControl } from "./selection";

test.each(["single", "batch", "partial-failure"] as const)(
    "%s refreshes changed package dependencies only after releasing the installation lease",
    async (mode) => {
        const state = await operationFixture();
        try {
            const target: UpdateTarget = {
                id: "demo-apt",
                source: "demo",
                label: "Demo",
                host: "fixture.invalid",
                user: "updater",
                port: 22,
                identityFile: "/fixture/key",
                knownHostsFile: "/fixture/known-hosts",
                sudo: false,
                driver: { kind: "apt" },
            };
            const sources = [
                { id: "demo", label: "Demo", publisher: crypto.randomUUID() },
            ];
            const stamp = new Date().toISOString();
            const items: UpdateItem[] = ["openssl", "demo", "libssl"].map((name) => ({
                id: `apt:${name}:amd64`,
                name,
                kind: "os",
                installed: "1.0-1",
                available: name === "libssl" ? "2.0-1" : "1.1-1",
                status: "available",
                held: false,
                security: false,
            }));
            const report: UpdateReport = {
                capturedAt: stamp,
                repositoryMetadataAt: stamp,
                aptObservedAt: stamp,
                complete: true,
                coveredKinds: ["os"],
                items,
            };
            await state.client`INSERT INTO operation_snapshots(key,value,captured_at)
                VALUES ('updates:demo',${JSON.stringify(report)}::text::jsonb,now())`;
            // Pausing periodic checks must not disable verification of an approved install.
            await state.client`INSERT INTO job_schedules(id,action,schedule,next_run_at,enabled,disable_reason)
                VALUES (${crypto.randomUUID()},'updates.releases','{"kind":"interval","intervalSeconds":3600}'::jsonb,now(),false,'Synthetic periodic pause')`;
            const installed = new Map(items.map((item) => [item.id, item.installed]));
            let reads = 0,
                installs = 0;
            const refresh = updatesJob(sources, state.client, fetch, [target], () => {
                reads++;
                return Promise.resolve({
                    repositoryMetadataAt: stamp,
                    items: items.map((item) => ({
                        ...item,
                        installed: installed.get(item.id)!,
                        status:
                            installed.get(item.id) === item.available
                                ? "current"
                                : "available",
                    })),
                });
            });
            const worker = await state.registerWorker();
            const registry = createJobRegistry([
                refresh,
                ...updateActionJobs(
                    [target],
                    state.client,
                    async (_target, item) => {
                        installs++;
                        installed.set(item.id, item.available!);
                        installed.set(items[2]!.id, items[2]!.available!);
                        expect(
                            await claimJob(state.client, worker, [refresh.definition.key])
                        ).toBeUndefined();
                        if (mode === "partial-failure")
                            throw new Error("Synthetic partial install");
                        return { installed: item.available!, rebootRequired: false };
                    },
                    [],
                    refresh
                ),
            ]);
            const principal = { kind: "human" as const, id: "operator", capabilities };
            const caller = appRouter.createCaller({
                operations: {
                    ...state,
                    registry,
                    updateTargets: [target],
                    updateSources: sources,
                },
                principal,
                verifyHuman: () => Promise.resolve(principal),
            });
            if (mode === "single") {
                await caller.updates.request({
                    target: target.id,
                    item: items[0]!.id,
                    revision: updateControl(target, report, items[0]!).revision,
                    requestId: crypto.randomUUID(),
                });
            } else {
                const plan = await caller.updates.batchPlan({ source: "demo" });
                expect(plan.eligible).toBe(2);
                await caller.updates.batchRequest({
                    source: "demo",
                    revision: plan.revision,
                    requestId: crypto.randomUUID(),
                });
            }
            const action =
                mode === "single"
                    ? `updates.install.${target.id}`
                    : updateBatchKey("demo");
            const claim = await claimJob(state.client, worker, [action]);
            if (!claim) throw new Error("Installation claim missing");
            const execution = registry.get(action)!.execute(claim.payload, {
                runId: claim.id,
                leaseToken: claim.lease_token,
                signal: AbortSignal.timeout(10_000),
                reportProgress: () => Promise.resolve(),
                commit: (write, queue) => commitClaim(state.client, claim, write, queue),
            });
            await (mode === "partial-failure"
                ? expect(execution).rejects.toThrow("Synthetic partial install")
                : execution);
            expect(reads).toBe(0);
            expect(installs).toBe(mode === "batch" ? 2 : 1);
            const pending = await state.client<{ payload: { source: string } }[]>`
                SELECT payload FROM job_runs WHERE action='updates.releases' AND state='queued'`;
            expect(pending).toHaveLength(1);
            expect(pending[0]?.payload).toEqual({ source: "demo" });
            expect(
                await claimJob(state.client, worker, [refresh.definition.key])
            ).toBeUndefined();
            await settleClaim(
                state.client,
                claim,
                mode === "partial-failure" ? "failed" : "succeeded"
            );
            const check = await claimJob(state.client, worker, [refresh.definition.key]);
            if (!check) throw new Error("Post-install refresh missing");
            await refresh.execute(check.payload, {
                runId: check.id,
                leaseToken: check.lease_token,
                signal: AbortSignal.timeout(10_000),
                reportProgress: () => Promise.resolve(),
                commit: (write, queue) => commitClaim(state.client, check, write, queue),
            });
            await settleClaim(state.client, check, "succeeded");
            expect(reads).toBe(1);
            const updated = await readUpdateReport(state.client, "demo");
            expect(updated?.items.find((item) => item.id === items[2]!.id)).toMatchObject(
                { installed: "2.0-1", status: "current" }
            );
        } finally {
            await state.close();
        }
    }
);
