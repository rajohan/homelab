import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import {
    updateChange,
    type UpdateItem,
    type UpdateReport,
} from "@homelab/contracts/updates";

import { appRouter } from "../../api/router";
import { claimJob, commitClaim, settleClaim } from "../../jobs/claims";
import { enqueueJob, lockQueue } from "../../jobs/queue";
import { createJobRegistry } from "../../jobs/registry";
import type { JobHandler } from "../../jobs/types";
import { operationFixture, expectOperationFailure } from "../../testing/operations";
import { updateActionJobs } from "./actions";
import { updateBatchKey } from "./batch";
import {
    parseUpdateTargets,
    updateTargetRevision,
    type UpdateTarget,
} from "./configuration";
import { updateSshArguments } from "./execution";
import { readUpdateReport } from "./inventory";
import { readUpdatePolicies, writeUpdatePolicy } from "./policies";
import { updateControl } from "./selection";

const target = parseUpdateTargets(
    JSON.stringify([
        {
            id: "demo-web",
            source: "demo",
            label: "Demo web",
            host: "fixture.invalid",
            user: "updater",
            port: 22,
            identityFile: "/run/secrets/test-key",
            knownHostsFile: "/run/secrets/test-known-hosts",
            driver: {
                kind: "docker",
                name: "demo-web-1",
                project: "demo",
                service: "web",
                directory: "/srv/demo",
                file: "/srv/demo/compose.yaml",
                imageFile: "/srv/demo/web/compose.yaml",
            },
        },
    ])
)[0]!;
const item: UpdateItem = {
    id: "docker:" + "a".repeat(64),
    name: "demo-web-1",
    kind: "container",
    installed: "sha256:" + "b".repeat(64),
    available: "sha256:" + "c".repeat(64),
    image: "example/web:1.2.3@sha256:" + "d".repeat(64),
    availableImage: "docker.io/example/web:1.3.0@sha256:" + "e".repeat(64),
    status: "available",
    held: false,
    security: false,
    pinned: true,
    candidateVerified: true,
    platform: { os: "linux", architecture: "amd64" },
};

test.each([
    "same-host",
    "bound-alias",
    "host-then-binding",
    "binding-then-host",
    "alternating-chain",
    "unbound",
    "wrong-digest",
    "changed-candidate",
    "different-request",
    "different-actor",
    "different-scope",
    "different-plan",
] as const)(
    "verified cross-source recreation receipts preserve batch consent during %s",
    async (scenario) => {
        const state = await operationFixture();
        try {
            if (target.driver.kind !== "docker")
                throw new Error("Missing Docker fixture");
            const provider: UpdateTarget = {
                ...target,
                id: "provider",
                source: "alpha",
                driver: {
                    ...target.driver,
                    name: "provider",
                    service: "provider",
                    namespaceDependents: ["web"],
                },
            };
            const consumer: UpdateTarget = {
                ...target,
                id: "consumer",
                source: "beta",
                host: [
                    "bound-alias",
                    "unbound",
                    "host-then-binding",
                    "binding-then-host",
                    "alternating-chain",
                ].includes(scenario)
                    ? "alias.invalid"
                    : target.host,
            };
            const providerItem = { ...item, name: "provider" };
            const consumerItem = { ...item, id: "docker:" + "b".repeat(64) };
            let bridgeSources: [string, string][] = [];
            let bindings = [["alpha", "beta", "snapshot-only"]];
            switch (scenario) {
                case "host-then-binding": {
                    bridgeSources = [["gamma", target.host]];
                    bindings = [["gamma", "beta", "snapshot-only"], ["alpha"]];
                    break;
                }
                case "binding-then-host": {
                    bridgeSources = [["gamma", consumer.host]];
                    bindings = [
                        ["beta", "snapshot-only"],
                        ["alpha", "gamma"],
                    ];
                    break;
                }
                case "alternating-chain": {
                    bridgeSources = [
                        ["gamma", target.host],
                        ["delta", "middle.invalid"],
                        ["epsilon", "middle.invalid"],
                    ];
                    bindings = [
                        ["epsilon", "beta", "snapshot-only"],
                        ["gamma", "delta"],
                        ["alpha"],
                    ];
                    break;
                }
                case "unbound": {
                    bindings = [];
                    break;
                }
            }
            const targets = [
                provider,
                consumer,
                ...bridgeSources.map(([source, host]) => ({
                    ...target,
                    id: source,
                    source,
                    host,
                    driver: {
                        ...provider.driver,
                        name: source,
                        service: source,
                        namespaceDependents: [],
                    },
                })),
            ];
            const calls: string[] = [];
            const applications = bindings.map((updateSources, index) => ({
                id: `docker-${index}`,
                label: "Docker",
                endpoint: "https://docker.invalid",
                projects: ["demo"],
                updateSources,
            }));
            const registry = createJobRegistry(
                updateActionJobs(
                    targets,
                    state.client,
                    (selected, software) => {
                        calls.push(software.id);
                        return Promise.resolve({
                            installed: software.available!,
                            rebootRequired: false,
                            containerId: (selected.id === "provider" ? "d" : "f").repeat(
                                64
                            ),
                            ...(selected.id === "provider"
                                ? {
                                      recreatedContainers: [
                                          {
                                              previousId: "b".repeat(64),
                                              containerId: "e".repeat(64),
                                              installed:
                                                  scenario === "wrong-digest"
                                                      ? "sha256:" + "9".repeat(64)
                                                      : consumerItem.installed,
                                          },
                                      ],
                                  }
                                : {}),
                        });
                    },
                    applications
                )
            );
            const report: UpdateReport = {
                capturedAt: new Date().toISOString(),
                repositoryMetadataAt: null,
                complete: true,
                coveredKinds: ["container"],
                rebootRequired: true,
                items: [consumerItem],
            };
            for (const source of ["alpha", "beta", "snapshot-only", "unrelated"])
                for (const prefix of ["updates:", "updates.resolved:"])
                    await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES (${prefix + source},${JSON.stringify({ ...report, items: [source === "alpha" ? providerItem : consumerItem] })}::text::jsonb,now())`;
            const principal = { kind: "human" as const, id: "operator", capabilities };
            const caller = appRouter.createCaller({
                operations: {
                    ...state,
                    registry,
                    updateTargets: targets,
                    updateSources: ["alpha", "beta"].map((id) => ({
                        id,
                        label: id,
                        publisher: crypto.randomUUID(),
                    })),
                },
                principal,
                verifyHuman: () => Promise.resolve(principal),
            });
            const plan = await caller.updates.batchPlan({});
            const request = { revision: plan.revision, requestId: crypto.randomUUID() };
            const accepted = await caller.updates.batchRequest(request);
            const [original] = await state.client<
                { id: string; payload: Record<string, unknown>; fingerprint: string }[]
            >`SELECT id,payload,fingerprint FROM job_runs WHERE action=${updateBatchKey("beta")}`;
            if (!original) throw new Error("Missing queued consumer");
            if (scenario === "changed-candidate")
                await state.client`UPDATE operation_snapshots SET value=jsonb_set(value,'{items,0,available}','"sha256:1111111111111111111111111111111111111111111111111111111111111111"'::jsonb) WHERE key IN ('updates:beta','updates.resolved:beta')`;
            if (scenario === "different-request")
                await state.client`UPDATE job_runs SET payload=jsonb_set(payload,'{requestId}',${JSON.stringify(crypto.randomUUID())}::text::jsonb) WHERE id=${original.id}`;
            if (scenario === "different-actor")
                await state.client`UPDATE job_runs SET requested_by='another-user' WHERE id=${original.id}`;
            if (scenario === "different-scope")
                await state.client`UPDATE job_runs SET payload=jsonb_set(payload,'{scope}','"beta"'::jsonb) WHERE id=${original.id}`;
            if (scenario === "different-plan")
                await state.client`UPDATE job_runs SET payload=jsonb_set(payload,'{revision}',${JSON.stringify("0".repeat(64))}::text::jsonb) WHERE id=${original.id}`;
            const worker = await state.registerWorker();
            const producer = await claimJob(state.client, worker, [
                updateBatchKey("alpha"),
            ]);
            if (!producer) throw new Error("Missing producer claim");
            if (scenario !== "unbound")
                expect(
                    await claimJob(state.client, worker, [updateBatchKey("beta")])
                ).toBeUndefined();
            await registry.get(producer.action)!.execute(producer.payload, {
                runId: producer.id,
                leaseToken: producer.lease_token,
                signal: AbortSignal.timeout(5000),
                reportProgress: () => Promise.resolve(),
                commit: (write, queue) =>
                    commitClaim(state.client, producer, write, queue),
            });
            await settleClaim(state.client, producer, "succeeded");
            const remapped = !["unbound", "wrong-digest"].includes(scenario);
            for (const source of ["beta", "snapshot-only", "unrelated"])
                for (const prefix of ["updates:", "updates.resolved:"]) {
                    const [stored] = await state.client<
                        { value: UpdateReport }[]
                    >`SELECT value FROM operation_snapshots WHERE key=${prefix + source}`;
                    expect(stored?.value.items[0]?.id).toBe(
                        "docker:" +
                            (remapped && source !== "unrelated" ? "e" : "b").repeat(64)
                    );
                    expect(stored?.value.items[0]?.installed).toBe(
                        consumerItem.installed
                    );
                    expect(stored?.value.rebootRequired).toBe(true);
                    expect(stored?.value.capturedAt).toBe(report.capturedAt);
                }
            const [queued] = await state.client<
                { payload: { items: { item: string }[] }; fingerprint: string }[]
            >`SELECT payload,fingerprint FROM job_runs WHERE id=${original.id}`;
            const continued = [
                "same-host",
                "bound-alias",
                "host-then-binding",
                "binding-then-host",
                "alternating-chain",
            ].includes(scenario);
            expect(queued?.payload.items[0]?.item).toBe(
                "docker:" + (continued ? "e" : "b").repeat(64)
            );
            expect(queued?.fingerprint).toBe(original.fingerprint);
            if (continued) {
                expect(await caller.updates.batchRequest(request)).toEqual(accepted);
                const next = await claimJob(state.client, worker, [
                    updateBatchKey("beta"),
                ]);
                if (!next) throw new Error("Missing consumer claim");
                await registry.get(next.action)!.execute(next.payload, {
                    runId: next.id,
                    leaseToken: next.lease_token,
                    signal: AbortSignal.timeout(5000),
                    reportProgress: () => Promise.resolve(),
                    commit: (write, queue) =>
                        commitClaim(state.client, next, write, queue),
                });
                expect(calls).toEqual([providerItem.id, "docker:" + "e".repeat(64)]);
            }
        } finally {
            await state.close();
        }
    }
);

async function batchFixture(fail = false, withDocker = false, sharedHost = false) {
    const state = await operationFixture();
    const targets: UpdateTarget[] = ["alpha", "beta"].map((source) => ({
        ...target,
        id: source,
        source,
        host: sharedHost ? "shared.invalid" : `${source}.invalid`,
        label: source,
        driver: { kind: "apt" as const },
    }));
    if (withDocker)
        targets.push(
            ...["alpha", "beta"].map((source) => ({
                ...target,
                id: source + "-docker",
                source,
                host: `${source}.invalid`,
            }))
        );
    const calls: { source: string; item: string }[] = [];
    const registry = createJobRegistry(
        updateActionJobs(targets, state.client, (selected, software) => {
            calls.push({ source: selected.source, item: software.id });
            if (fail) return Promise.reject(new Error("Synthetic installation failure"));
            return Promise.resolve({
                installed: software.available!,
                rebootRequired: false,
            });
        })
    );
    const operations = {
        ...state,
        registry,
        updateTargets: targets,
        updateSources: targets
            .filter((selected) => selected.driver.kind === "apt")
            .map((selected) => ({
                id: selected.source,
                label: selected.label,
                publisher: crypto.randomUUID(),
            })),
    };
    const principal = { kind: "human" as const, id: "operator", capabilities };
    const caller = appRouter.createCaller({
        operations,
        principal,
        verifyHuman: () => Promise.resolve(principal),
    });
    const report: UpdateReport = {
        capturedAt: new Date().toISOString(),
        repositoryMetadataAt: new Date().toISOString(),
        complete: true,
        coveredKinds: [
            "os",
            "application",
            ...(withDocker ? ["container" as const] : []),
        ],
        items: [
            ...(withDocker ? [item] : []),
            ...Array.from({ length: 70 }, (_, index) => ({
                id: `apt:package-${String(index).padStart(3, "0")}`,
                name: `Package ${index}`,
                kind: "os" as const,
                installed: "1.0-1",
                available: index === 1 ? "2.0-1" : "1.1-1",
                status: "available" as const,
                held: index === 0,
                security: false,
            })),
            {
                ...item,
                id: "application:unconfigured",
                name: "Unconfigured",
                kind: "application",
                installed: "1.0.0",
                available: "1.1.0",
            },
        ],
    };
    for (const source of operations.updateSources) {
        await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES (${`updates:${source.id}`},${JSON.stringify(report)}::text::jsonb,now())`;
        if (withDocker)
            await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES (${`updates.resolved:${source.id}`},${JSON.stringify(report)}::text::jsonb,now())`;
    }
    return { ...state, targets, calls, operations, caller, principal, registry };
}

test.each(["demo-web-1", "custom-consumer"])(
    "a host batch remaps recreated %s by identity without losing versions",
    async (name) => {
        const state = await operationFixture();
        try {
            if (target.driver.kind !== "docker")
                throw new Error("Missing Docker fixture");
            const provider: UpdateTarget = {
                ...target,
                id: "demo-provider",
                driver: {
                    ...target.driver,
                    name: "demo-provider-1",
                    service: "provider",
                    namespaceDependents: ["web"],
                },
            };
            const consumerTarget: UpdateTarget = {
                ...target,
                driver: { ...target.driver, name },
            };
            const consumerItem: UpdateItem = {
                ...item,
                name,
                id: "docker:" + "b".repeat(64),
            };
            const unrelated: UpdateItem = {
                ...consumerItem,
                name: "unrelated",
                id: "docker:" + "f".repeat(64),
                status: "current",
                installed: consumerItem.available!,
            };
            const providerItem: UpdateItem = { ...item, name: "demo-provider-1" };
            const calls: string[] = [];
            const registry = createJobRegistry(
                updateActionJobs(
                    [provider, consumerTarget],
                    state.client,
                    (selected, software) => {
                        calls.push(selected.id);
                        return Promise.resolve({
                            installed: software.available!,
                            rebootRequired: false,
                            containerId: (selected.id === provider.id ? "d" : "c").repeat(
                                64
                            ),
                            ...(selected.id === provider.id
                                ? {
                                      recreatedContainers: [
                                          {
                                              previousId: "c".repeat(64),
                                              containerId: "e".repeat(64),
                                              installed: consumerItem.available!,
                                          },
                                      ],
                                  }
                                : {}),
                        });
                    }
                )
            );
            const report: UpdateReport = {
                capturedAt: new Date().toISOString(),
                repositoryMetadataAt: null,
                complete: true,
                coveredKinds: ["container"],
                items: [providerItem, consumerItem, unrelated],
            };
            for (const key of ["updates:demo", "updates.resolved:demo"])
                await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES (${key},${JSON.stringify(report)}::text::jsonb,now())`;
            const principal = { kind: "human" as const, id: "operator", capabilities };
            const caller = appRouter.createCaller({
                operations: {
                    ...state,
                    registry,
                    updateTargets: [provider, consumerTarget],
                    updateSources: [
                        { id: "demo", label: "Demo", publisher: crypto.randomUUID() },
                    ],
                },
                principal,
                verifyHuman: () => Promise.resolve(principal),
            });
            const plan = await caller.updates.batchPlan({ source: "demo" });
            expect(plan.eligible).toBe(2);
            await caller.updates.batchRequest({
                source: "demo",
                revision: plan.revision,
                requestId: crypto.randomUUID(),
            });
            const worker = await state.registerWorker();
            const handler = registry.get(updateBatchKey("demo"))!;
            const claim = await claimJob(state.client, worker, [handler.definition.key]);
            expect(claim).toBeDefined();
            await handler.execute(claim!.payload, {
                runId: claim!.id,
                leaseToken: claim!.lease_token,
                signal: AbortSignal.timeout(5000),
                reportProgress: () => Promise.resolve(),
                commit: (write, queue) => commitClaim(state.client, claim!, write, queue),
            });
            expect(calls).toEqual([target.id, provider.id]);
            const current = await readUpdateReport(state.client, "demo");
            expect(
                current?.items.find((row) => row.name === consumerItem.name)
            ).toMatchObject({
                id: "docker:" + "e".repeat(64),
                installed: consumerItem.available,
                status: "current",
            });
            expect(
                current?.items.find((row) => row.name === providerItem.name)
            ).toMatchObject({ id: "docker:" + "d".repeat(64), status: "current" });
            for (const key of ["updates:demo", "updates.resolved:demo"]) {
                const [stored] = await state.client<
                    { value: UpdateReport }[]
                >`SELECT value FROM operation_snapshots WHERE key=${key}`;
                expect(
                    stored?.value.items.find((row) => row.name === name)
                ).toMatchObject({
                    id: "docker:" + "e".repeat(64),
                    installed: consumerItem.available,
                    status: "current",
                });
                expect(
                    stored?.value.items.find((row) => row.name === unrelated.name)
                ).toEqual(unrelated);
            }
        } finally {
            await state.close();
        }
    }
);

test("bulk plans cover every page, expose exclusions and preserve host scope and permissions", async () => {
    const state = await batchFixture();
    try {
        const all = await state.caller.updates.batchPlan({});
        expect(all.entries).toHaveLength(142);
        expect(all).toMatchObject({ eligible: 136, excluded: 6, hosts: 2 });
        const host = await state.caller.updates.batchPlan({ source: "alpha" });
        expect(host.entries.every((entry) => entry.source === "alpha")).toBe(true);
        expect(host).toMatchObject({ eligible: 68, excluded: 3, hosts: 1 });
        expect(
            host.entries.find((entry) => entry.item.id.endsWith("001"))?.reason
        ).toContain("Major");
        const request = { revision: all.revision, requestId: crypto.randomUUID() };
        const noProof = appRouter.createCaller({
            operations: state.operations,
            principal: state.principal,
        });
        await expectOperationFailure(
            noProof.updates.batchRequest(request),
            "recently verified"
        );
        const noJobs = appRouter.createCaller({
            operations: state.operations,
            principal: { ...state.principal, capabilities: ["updates:apply"] },
            verifyHuman: () => Promise.resolve(state.principal),
        });
        await expectOperationFailure(noJobs.updates.batchRequest(request), "permission");
        await expectOperationFailure(
            state.caller.updates.batchPlan({ source: "removed" }),
            "not configured"
        );
        const queued = await state.caller.updates.batchRequest(request);
        expect(queued.ids).toHaveLength(2);
        const [budget] = await state.client<
            { timeout_ms: number }[]
        >`SELECT timeout_ms FROM job_runs WHERE id=${queued.id}`;
        expect(budget?.timeout_ms).toBe(68 * 1_530_000 + 60_000);
        await expectOperationFailure(
            state.client`UPDATE job_runs SET retry_safe=true WHERE id=${queued.id}`,
            "job_runs_attempts"
        );
        await expectOperationFailure(
            state.client`UPDATE job_runs SET timeout_ms=604800001 WHERE id=${queued.id}`,
            "job_runs_attempts"
        );
        await expectOperationFailure(
            state.client`UPDATE job_runs SET attempt_limit=2 WHERE id=${queued.id}`,
            "job_runs_attempts"
        );
        expect(await state.caller.updates.batchRequest(request)).toEqual(queued);
        await expectOperationFailure(
            state.caller.updates.batchRequest({ ...request, source: "alpha" }),
            "another update plan"
        );
        expect(state.calls).toHaveLength(0);
    } finally {
        await state.close();
    }
});

test.each([false, true])(
    "host batches share leases and run concurrently with Docker=%s",
    async (withDocker) => {
        const state = await batchFixture(false, withDocker);
        try {
            const plan = await state.caller.updates.batchPlan({});
            await state.caller.updates.batchRequest({
                revision: plan.revision,
                requestId: crypto.randomUUID(),
            });
            const alpha = state.registry.get(updateBatchKey("alpha"))!,
                beta = state.registry.get(updateBatchKey("beta"))!;
            const worker = await state.registerWorker();
            const first = await claimJob(state.client, worker, [alpha.definition.key]);
            const second = await claimJob(state.client, worker, [beta.definition.key]);
            expect(first).toBeDefined();
            expect(second).toBeDefined();
            expect(first!.timeout_ms).toBe((withDocker ? 69 : 68) * 1_530_000 + 60_000);
            expect(first!.timeout_ms).toBeGreaterThan(3_600_000);
            const entry = plan.entries.find(
                (candidate) => candidate.source === "alpha" && candidate.reason === null
            )!;
            await state.caller.updates.request({
                target: entry.control!.target,
                item: entry.item.id,
                revision: entry.control!.revision,
                requestId: crypto.randomUUID(),
            });
            expect(
                await claimJob(state.client, worker, ["updates.install.alpha"])
            ).toBeUndefined();
            const run = async (claim: NonNullable<typeof first>, handler: JobHandler) => {
                await handler.execute(claim.payload, {
                    runId: claim.id,
                    leaseToken: claim.lease_token,
                    signal: AbortSignal.timeout(20_000),
                    reportProgress: () => Promise.resolve(),
                    commit: (write, queue) =>
                        commitClaim(state.client, claim, write, queue),
                });
                await settleClaim(state.client, claim, "succeeded");
            };
            await Promise.all([run(first!, alpha), run(second!, beta)]);
            for (const source of ["alpha", "beta"]) {
                const calls = state.calls.filter((call) => call.source === source);
                expect(calls).toHaveLength(withDocker ? 69 : 68);
                expect(calls.findLast((call) => call.item.startsWith("apt:"))?.item).toBe(
                    "apt:package-069"
                );
                const report = await readUpdateReport(state.client, source);
                expect(
                    report?.items.filter((software) => software.status === "current")
                ).toHaveLength(withDocker ? 69 : 68);
            }
        } finally {
            await state.close();
        }
    }
);

test.each([
    "success",
    "idle",
    "actor",
    "request",
    "revision",
    "scope",
    "overlap",
    "budget",
    "host",
    "failed",
    "cancelled",
    "timed_out",
] as const)(
    "serialized source aliases credit only their successful shared confirmation runtime (%s)",
    async (scenario) => {
        const state = await batchFixture(false, false, scenario !== "host");
        try {
            for (const source of ["alpha", "beta"]) {
                const report = await readUpdateReport(state.client, source);
                await state.client`UPDATE operation_snapshots SET value=${JSON.stringify({ ...report, items: report!.items.slice(2, 6) })}::text::jsonb WHERE key=${`updates:${source}`}`;
            }
            const plan = await state.caller.updates.batchPlan({});
            await state.caller.updates.batchRequest({
                revision: plan.revision,
                requestId: crypto.randomUUID(),
            });
            const alpha = state.registry.get(updateBatchKey("alpha"))!,
                beta = state.registry.get(updateBatchKey("beta"))!;
            const worker = await state.registerWorker();
            const first = await claimJob(state.client, worker, [alpha.definition.key]);
            if (!first) throw new Error("Expected first alias claim");
            if (scenario !== "host")
                expect(
                    await claimJob(state.client, worker, [beta.definition.key])
                ).toBeUndefined();
            await alpha.execute(first.payload, {
                runId: first.id,
                leaseToken: first.lease_token,
                signal: AbortSignal.timeout(5000),
                reportProgress: () => Promise.resolve(),
                commit: (write, queue) => commitClaim(state.client, first, write, queue),
            });
            await settleClaim(state.client, first, "succeeded");
            await state.client`UPDATE job_runs SET created_at=now()-interval '100 minutes'`;
            await state.client`UPDATE job_runs SET started_at=now()-interval '97 minutes', finished_at=now()-interval '2 minutes' WHERE id=${first.id}`;
            if (scenario === "idle")
                await state.client`UPDATE job_runs SET created_at=now()-interval '160 minutes'`;
            if (scenario === "actor")
                await state.client`UPDATE job_runs SET requested_by='human:someone-else' WHERE id=${first.id}`;
            if (scenario === "scope")
                await state.client`UPDATE job_runs SET payload=jsonb_set(payload,'{scope}','"alpha"'::jsonb) WHERE id=${first.id}`;
            if (scenario === "budget")
                await state.client`UPDATE job_runs SET timeout_ms=1000 WHERE id=${first.id}`;
            if (scenario === "overlap") {
                const duplicate = await state.client.begin(async (transaction) => {
                    await lockQueue(transaction);
                    return enqueueJob(
                        transaction,
                        alpha.definition,
                        "human:operator",
                        crypto.randomUUID(),
                        first.payload
                    );
                });
                await state.client`UPDATE job_runs SET state='succeeded', started_at=now()-interval '97 minutes', finished_at=now()-interval '2 minutes' WHERE id=${duplicate}`;
                await state.client`UPDATE job_runs SET created_at=now()-interval '200 minutes'`;
            }
            if (scenario === "request" || scenario === "revision")
                await state.client`UPDATE job_runs SET payload=jsonb_set(payload,${state.client.array([scenario === "request" ? "requestId" : "revision"], "TEXT")},${JSON.stringify(crypto.randomUUID())}::text::jsonb) WHERE id=${first.id}`;
            const blocked =
                scenario === "failed" ||
                scenario === "cancelled" ||
                scenario === "timed_out";
            if (blocked)
                await state.client`UPDATE job_runs SET state=${scenario} WHERE id=${first.id}`;
            const second = await claimJob(state.client, worker, [beta.definition.key]);
            if (!second) throw new Error("Expected second alias claim");
            const execution = beta.execute(second.payload, {
                runId: second.id,
                leaseToken: second.lease_token,
                signal: AbortSignal.timeout(5000),
                reportProgress: () => Promise.resolve(),
                commit: (write, queue) => commitClaim(state.client, second, write, queue),
            });
            await (scenario === "success"
                ? execution
                : expectOperationFailure(
                      execution,
                      blocked ? "remaining updates were not started" : "expired"
                  ));
            expect(state.calls.filter((call) => call.source === "beta")).toHaveLength(
                scenario === "success" ? 4 : 0
            );
        } finally {
            await state.close();
        }
    }
);

test("bulk deadlines bound large confirmations before any job is admitted", async () => {
    const state = await batchFixture();
    try {
        const report = await readUpdateReport(state.client, "alpha");
        const seed = report!.items[2]!;
        const replace = (length: number) =>
            state.client`UPDATE operation_snapshots SET value=${JSON.stringify({ ...report, items: Array.from({ length }, (_, index) => ({ ...seed, id: `apt:large-${index}` })) })}::text::jsonb WHERE key='updates:alpha'`;
        await replace(395);
        const plan = await state.caller.updates.batchPlan({ source: "alpha" });
        expect(plan.eligible).toBe(395);
        await replace(396);
        await expectOperationFailure(
            state.caller.updates.batchPlan({ source: "alpha" }),
            "at most 395"
        );
        const [count] = await state.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM job_runs`;
        expect(count?.count).toBe(0);
    } finally {
        await state.close();
    }
});

test.each([
    "changed-plan",
    "changed-candidate",
    "expired",
    "failure",
    "cancelled",
] as const)("bulk updates fail closed and do not continue after %s", async (scenario) => {
    const state = await batchFixture(scenario === "failure");
    try {
        const plan = await state.caller.updates.batchPlan({ source: "alpha" });
        const request = {
            source: "alpha",
            revision: plan.revision,
            requestId: crypto.randomUUID(),
        };
        const alter = () =>
            state.client`UPDATE operation_snapshots SET value=jsonb_set(value, '{items,2,available}', '"1.2-1"'::jsonb) WHERE key='updates:alpha'`;
        if (scenario === "changed-plan") {
            await alter();
            await expectOperationFailure(
                state.caller.updates.batchRequest(request),
                "plan changed"
            );
            const [count] = await state.client<
                { count: number }[]
            >`SELECT count(*)::int AS count FROM job_runs`;
            expect(count?.count).toBe(0);
            return;
        }
        const queued = await state.caller.updates.batchRequest(request);
        if (scenario === "changed-candidate") await alter();
        if (scenario === "expired")
            await state.client`UPDATE job_runs SET created_at=now()-interval '61 minutes' WHERE id=${queued.id}`;
        const handler = state.registry.get(updateBatchKey("alpha"))!;
        const worker = await state.registerWorker();
        const claim = await claimJob(state.client, worker, [handler.definition.key]);
        if (!claim) throw new Error("Expected batch claim");
        const lifecycle = new AbortController();
        if (scenario === "cancelled") lifecycle.abort(new Error("Cancelled"));
        await expectOperationFailure(
            handler.execute(claim.payload, {
                runId: claim.id,
                leaseToken: claim.lease_token,
                signal: lifecycle.signal,
                reportProgress: () => Promise.resolve(),
                commit: (write, queue) => commitClaim(state.client, claim, write, queue),
            }),
            {
                expired: "expired",
                "changed-candidate": "changed",
                cancelled: "Cancelled",
                failure: "Synthetic",
            }[scenario]
        );
        expect(state.calls).toHaveLength(scenario === "failure" ? 1 : 0);
    } finally {
        await state.close();
    }
});

async function fixture(
    selectedTarget: UpdateTarget = target,
    observedItem: UpdateItem = item,
    rebootRequired: boolean | null = true
) {
    const state = await operationFixture();
    const calls: { item: UpdateItem; automatic: boolean }[] = [];
    const handlers = updateActionJobs(
        [selectedTarget],
        state.client,
        async (_target, software, automatic, _signal, report) => {
            calls.push({ item: software, automatic });
            await report("Verifying the synthetic update.");
            return {
                installed: software.available!,
                rebootRequired,
                ...(selectedTarget.driver.kind === "docker"
                    ? { containerId: "f".repeat(64) }
                    : {}),
            };
        }
    );
    const operations = {
        ...state,
        registry: createJobRegistry(handlers),
        updateTargets: [selectedTarget],
        updateSources: [{ id: "demo", label: "Demo", publisher: crypto.randomUUID() }],
    };
    const principal = { kind: "human" as const, id: "operator", capabilities };
    const caller = appRouter.createCaller({
        operations,
        principal,
        verifyHuman: () => Promise.resolve(principal),
    });
    const report: UpdateReport & { checkedAt: string } = {
        capturedAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        repositoryMetadataAt:
            observedItem.kind === "os" ? new Date().toISOString() : null,
        complete: true,
        coveredKinds: [observedItem.kind],
        items: [observedItem],
    };
    await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('updates:demo',${JSON.stringify(report)}::text::jsonb,now())`;
    await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('updates.resolved:demo',${JSON.stringify(report)}::text::jsonb,now())`;
    const worker = await state.registerWorker();
    const run = async (handler: JobHandler) => {
        const claim = await claimJob(state.client, worker, [handler.definition.key]);
        if (!claim) throw new Error("Expected a queued fixture job");
        try {
            await handler.execute(claim.payload, {
                runId: claim.id,
                leaseToken: claim.lease_token,
                signal: AbortSignal.timeout(5000),
                reportProgress: () => Promise.resolve(),
                commit: (write, queue) => commitClaim(state.client, claim, write, queue),
            });
            await settleClaim(state.client, claim, "succeeded");
        } catch (error) {
            await settleClaim(state.client, claim, "failed");
            throw error;
        }
        return claim.id;
    };
    return { ...state, operations, caller, calls, report, handlers, run, principal };
}

test("a later batch item's new receipt leases are checked before the first APT installer", async () => {
    const state = await batchFixture(false, true);
    try {
        const plan = await state.caller.updates.batchPlan({ source: "alpha" });
        expect(plan.eligible).toBeGreaterThan(1);
        await state.caller.updates.batchRequest({
            source: "alpha",
            revision: plan.revision,
            requestId: crypto.randomUUID(),
        });
        const worker = await state.registerWorker();
        const action = updateBatchKey("alpha");
        const claim = await claimJob(state.client, worker, [action]);
        if (!claim) throw new Error("Expected batch claim");
        let executed = 0;
        const handler = updateActionJobs(
            state.targets,
            state.client,
            (_target, software) => {
                executed += 1;
                return Promise.resolve({
                    installed: software.available!,
                    rebootRequired: false,
                });
            },
            [
                {
                    id: "docker",
                    label: "Docker",
                    endpoint: "https://docker.invalid",
                    projects: ["demo"],
                    updateSources: ["alpha", "beta"],
                },
            ]
        ).find((candidate) => candidate.definition.key === action)!;
        await expectOperationFailure(
            handler.execute(claim.payload, {
                runId: claim.id,
                leaseToken: claim.lease_token,
                signal: AbortSignal.timeout(5000),
                reportProgress: () => Promise.resolve(),
                commit: (write, queue) => commitClaim(state.client, claim, write, queue),
            }),
            "host bindings changed"
        );
        expect(executed).toBe(0);
    } finally {
        await state.close();
    }
});

test.each(["install", "batch"] as const)(
    "%s revalidates current receipt and host leases before execution",
    async (mode) => {
        for (const scenario of [
            "binding",
            "ssh",
            "same-source",
            "unchanged",
            "same-keys",
        ] as const) {
            const state = await fixture();
            try {
                const action =
                    mode === "install"
                        ? `updates.install.${target.id}`
                        : updateBatchKey(target.source);
                if (mode === "install")
                    await state.caller.updates.request({
                        target: target.id,
                        item: item.id,
                        revision: updateControl(target, state.report, item).revision,
                        requestId: crypto.randomUUID(),
                    });
                else {
                    const plan = await state.caller.updates.batchPlan({
                        source: target.source,
                    });
                    expect(plan.eligible).toBe(1);
                    await state.caller.updates.batchRequest({
                        source: target.source,
                        revision: plan.revision,
                        requestId: crypto.randomUUID(),
                    });
                }
                const before = await state.client<
                    { key: string; value: unknown }[]
                >`SELECT key,value FROM operation_snapshots WHERE key LIKE 'updates%' ORDER BY key`;
                const [admitted] = await state.client<
                    { resource_keys: string[] }[]
                >`SELECT resource_keys FROM job_runs WHERE action=${action}`;
                const peer: UpdateTarget = {
                    ...target,
                    id: "peer",
                    source: ["same-source", "same-keys"].includes(scenario)
                        ? target.source
                        : "peer",
                    host: ["ssh", "same-keys"].includes(scenario)
                        ? target.host
                        : "peer.invalid",
                };
                const currentTargets =
                    scenario === "unchanged" ? [target] : [peer, target];
                const applications =
                    scenario === "binding"
                        ? [
                              {
                                  id: "docker",
                                  label: "Docker",
                                  endpoint: "https://docker.invalid",
                                  projects: ["demo"],
                                  updateSources: [target.source, peer.source],
                              },
                          ]
                        : [];
                let executed = 0;
                const handler = updateActionJobs(
                    currentTargets,
                    state.client,
                    (_target, software) => {
                        executed += 1;
                        return Promise.resolve({
                            installed: software.available!,
                            rebootRequired: false,
                            containerId: "f".repeat(64),
                        });
                    },
                    applications
                ).find((candidate) => candidate.definition.key === action)!;
                if (["unchanged", "same-keys"].includes(scenario)) {
                    await state.run(handler);
                    expect(executed).toBe(1);
                } else {
                    await expectOperationFailure(
                        state.run(handler),
                        "host bindings changed"
                    );
                    expect(executed).toBe(0);
                    expect(
                        await state.client<
                            { key: string; value: unknown }[]
                        >`SELECT key,value FROM operation_snapshots WHERE key LIKE 'updates%' ORDER BY key`
                    ).toEqual(before);
                }
                const [after] = await state.client<
                    { resource_keys: string[] }[]
                >`SELECT resource_keys FROM job_runs WHERE action=${action}`;
                expect(after!.resource_keys).toEqual(admitted!.resource_keys);
            } finally {
                await state.close();
            }
        }
    }
);

test("manual Docker updates require current confirmation, MFA and permission and preserve idempotency", async () => {
    const state = await fixture();
    try {
        const control = updateControl(target, state.report, item);
        const input = {
            target: target.id,
            item: item.id,
            revision: control.revision,
            requestId: crypto.randomUUID(),
        };
        const noProof = appRouter.createCaller({
            operations: state.operations,
            principal: state.principal,
        });
        await expectOperationFailure(noProof.updates.request(input), "recently verified");
        const reader = appRouter.createCaller({
            operations: state.operations,
            principal: { ...state.principal, capabilities: ["updates:read"] },
        });
        await expectOperationFailure(reader.updates.request(input), "permission");
        await expectOperationFailure(
            state.caller.updates.request({ ...input, revision: "a".repeat(64) }),
            "changed"
        );
        const first = await state.caller.updates.request(input);
        expect(await state.caller.updates.request(input)).toEqual(first);
        const id = await state.run(state.handlers[0]!);
        expect(id).toBe(first.id);
        expect(state.calls).toHaveLength(1);
        expect(state.calls[0]?.automatic).toBe(false);
        const saved = await readUpdateReport(state.client, "demo");
        expect(saved?.items[0]?.status).toBe("current");
        expect(saved?.items[0]?.image).toBe(item.availableImage);
        expect(saved?.items[0]?.id).toBe("docker:" + "f".repeat(64));
        const [notification] = await state.client<
            { title: string }[]
        >`SELECT title FROM dashboard_notifications WHERE source='updates'`;
        expect(notification).toBeUndefined();
        expect(saved?.rebootRequired).toBe(true);
        expect(await state.caller.updates.request(input)).toEqual(first);
        await expectOperationFailure(
            state.caller.updates.request({ ...input, item: "different" }),
            "different job"
        );
    } finally {
        await state.close();
    }
});

test.each(["docker", "native", "apt"] as const)(
    "%s receipts preserve host restart state without attributing existing OS requirements to applications",
    async (kind) => {
        const drivers: Record<typeof kind, UpdateTarget["driver"]> = {
            docker: target.driver,
            apt: { kind: "apt" },
            native: {
                kind: "native",
                item: "runtime:demo",
                release: "bun",
                inspect: ["/bin/demo", "--version"],
                install: ["/bin/demo", "install", "{version}"],
                health: ["/bin/demo", "health"],
            },
        };
        const configured: UpdateTarget = { ...target, driver: drivers[kind] };
        const observed: UpdateItem =
            kind === "docker"
                ? item
                : {
                      id: kind === "apt" ? "apt:demo" : "runtime:demo",
                      name: "Demo software",
                      kind: kind === "apt" ? "os" : "runtime",
                      installed: "1.2.3",
                      available: "1.3.0",
                      status: "available",
                      security: false,
                      held: false,
                      candidateVerified: true,
                      ...(kind === "native" ? { release: "bun" as const } : {}),
                  };
        for (const required of [true, false, null]) {
            const state = await fixture(configured, observed, required);
            try {
                const control = updateControl(configured, state.report, observed);
                expect(control.allowed).toBe(true);
                await state.caller.updates.request({
                    target: configured.id,
                    item: observed.id,
                    revision: control.revision,
                    requestId: crypto.randomUUID(),
                });
                await state.run(state.handlers[0]!);
                const saved = await readUpdateReport(state.client, "demo");
                expect(saved?.rebootRequired).toBe(required);
                expect(saved?.items[0]?.status).toBe("current");
                const [restart] = await state.client<{ required: boolean | null }[]>`
                    SELECT value->'required' AS required FROM operation_snapshots
                    WHERE key='updates.restart:demo'`;
                expect(restart?.required).toBe(required);
                const notifications = await state.client<{ title: string }[]>`
                    SELECT title FROM dashboard_notifications WHERE source='updates'`;
                expect(notifications).toHaveLength(kind === "apt" && required ? 1 : 0);
            } finally {
                await state.close();
            }
        }
    }
);

test("automatic policies default off, require human consent, reject concurrent edits and invalidate changed recipes", async () => {
    const state = await fixture();
    try {
        const before = await state.caller.updates.policies();
        expect(before[0]?.enabled).toBe(false);
        const machine = appRouter.createCaller({
            operations: state.operations,
            principal: { kind: "automation", id: crypto.randomUUID(), capabilities },
        });
        await expectOperationFailure(
            machine.updates.policy({ target: target.id, version: 0, enabled: true }),
            "operator"
        );
        await state.caller.updates.policy({
            target: target.id,
            version: 0,
            enabled: true,
        });
        await expectOperationFailure(
            state.caller.updates.policy({
                target: target.id,
                version: 0,
                enabled: false,
            }),
            "policy changed"
        );
        const enabled = await readUpdatePolicies(state.client, [target]);
        expect(enabled[0]?.enabled).toBe(true);
        const changed = { ...target, user: "other" };
        expect(updateTargetRevision(changed)).not.toBe(updateTargetRevision(target));
        const invalidated = await readUpdatePolicies(state.client, [changed]);
        expect(invalidated[0]).toMatchObject({
            enabled: false,
            configurationChanged: true,
        });
        await state.caller.updates.policy({
            target: target.id,
            version: 1,
            enabled: false,
        });
        const disabled = await state.caller.updates.policies();
        expect(disabled[0]?.enabled).toBe(false);
    } finally {
        await state.close();
    }
});

test.each(["minor", "major", "unknown", "held", "stale"] as const)(
    "automatic admission accepts only enabled eligible updates (%s)",
    async (mode) => {
        const state = await fixture();
        try {
            const candidate = { ...item };
            if (mode === "major")
                candidate.availableImage =
                    "docker.io/example/web:2.0.0@sha256:" + "e".repeat(64);
            if (mode === "unknown")
                candidate.image = "example/web:latest@sha256:" + "d".repeat(64);
            if (mode === "held") candidate.held = true;
            const observation = {
                ...state.report,
                complete: mode !== "stale",
                items: [candidate],
            };
            await state.client`UPDATE operation_snapshots SET value=${JSON.stringify(observation)}::text::jsonb WHERE key IN ('updates:demo','updates.resolved:demo')`;
            const automatic = state.handlers.find(
                (handler) => handler.definition.key === "updates.automatic"
            )!;
            const schedule = async () => {
                await state.client.begin(async (transaction) => {
                    await lockQueue(transaction);
                    await enqueueJob(
                        transaction,
                        automatic.definition,
                        "system:test",
                        crypto.randomUUID()
                    );
                });
                await state.run(automatic);
            };
            await schedule();
            expect(state.calls).toHaveLength(0);
            await writeUpdatePolicy(state.client, target, "human:operator", {
                enabled: true,
                version: 0,
            });
            await schedule();
            const queued = await state.client<
                { count: number }[]
            >`SELECT count(*)::int AS count FROM job_runs WHERE action=${state.handlers[0]!.definition.key}`;
            expect(queued[0]?.count).toBe(mode === "minor" ? 1 : 0);
            if (mode === "minor") {
                await state.run(state.handlers[0]!);
                expect(state.calls[0]?.automatic).toBe(true);
                await schedule();
                expect(state.calls).toHaveLength(1);
            }
        } finally {
            await state.close();
        }
    }
);

test("queued updates reject changed observations before execution", async () => {
    const state = await fixture();
    try {
        const control = updateControl(target, state.report, item);
        await state.caller.updates.request({
            target: target.id,
            item: item.id,
            revision: control.revision,
            requestId: crypto.randomUUID(),
        });
        await state.client`UPDATE operation_snapshots SET value=jsonb_set(value,'{complete}','false'::jsonb) WHERE key IN ('updates:demo','updates.resolved:demo')`;
        await expectOperationFailure(state.run(state.handlers[0]!), "changed");
        expect(state.calls).toHaveLength(0);
    } finally {
        await state.close();
    }
});

test.each(["disabled", "expired", "failed"] as const)(
    "automatic updates do not execute after revoked consent or silently retry (%s)",
    async (mode) => {
        const state = await fixture();
        try {
            await writeUpdatePolicy(state.client, target, "human:operator", {
                enabled: true,
                version: 0,
            });
            const automatic = state.handlers.find(
                (handler) => handler.definition.key === "updates.automatic"
            )!;
            const schedule = async () => {
                await state.client.begin(async (transaction) => {
                    await lockQueue(transaction);
                    await enqueueJob(
                        transaction,
                        automatic.definition,
                        "system:test",
                        crypto.randomUUID()
                    );
                });
                await state.run(automatic);
            };
            await schedule();
            if (mode === "disabled") {
                await writeUpdatePolicy(state.client, target, "human:operator", {
                    enabled: false,
                    version: 1,
                });
                await expectOperationFailure(
                    state.run(state.handlers[0]!),
                    "permission changed"
                );
            } else if (mode === "expired") {
                await state.client`UPDATE job_runs SET created_at=now()-interval '6 minutes' WHERE action=${state.handlers[0]!.definition.key}`;
                await expectOperationFailure(state.run(state.handlers[0]!), "expired");
            } else {
                const failed = {
                    ...state.handlers[0]!,
                    execute: () =>
                        Promise.reject(new Error("Synthetic installation failed")),
                };
                await expectOperationFailure(state.run(failed), "failed");
            }
            await schedule();
            const [runs] = await state.client<
                { count: number }[]
            >`SELECT count(*)::int AS count FROM job_runs WHERE action=${state.handlers[0]!.definition.key}`;
            expect(runs?.count).toBe(1);
            expect(state.calls).toHaveLength(0);
        } finally {
            await state.close();
        }
    }
);

test("publisher fields cannot impersonate a worker-verified Docker candidate", async () => {
    const state = await fixture();
    try {
        await state.client`DELETE FROM operation_snapshots WHERE key='updates.resolved:demo'`;
        const report = await readUpdateReport(state.client, "demo");
        expect(report?.checkedAt).toBeNull();
        expect(updateControl(target, report!, item).allowed).toBe(false);
        await expectOperationFailure(
            state.caller.updates.request({
                target: target.id,
                item: item.id,
                revision: updateControl(target, report!, item).revision,
                requestId: crypto.randomUUID(),
            }),
            "verify"
        );
        expect(state.calls).toHaveLength(0);
    } finally {
        await state.close();
    }
});

test.each(["docker-channel", "docker-provider", "native-provider"] as const)(
    "worker-verified off-target candidates cannot authorize manual, queued or automatic installs (%s)",
    async (mode) => {
        const native = mode === "native-provider";
        const configured = parseUpdateTargets(
            JSON.stringify([
                {
                    ...target,
                    driver: native
                        ? {
                              kind: "native",
                              item: "runtime:demo",
                              release: "bun",
                              inspect: ["/bin/demo", "--version"],
                              install: ["/bin/demo", "install", "{version}"],
                              health: ["/bin/demo", "health"],
                          }
                        : { ...target.driver, trackingTag: "stable" },
                },
            ])
        )[0]!;
        const original: UpdateItem = native
            ? {
                  id: "runtime:demo",
                  name: "Demo runtime",
                  kind: "runtime",
                  installed: "1.2.3",
                  available: "1.3.0",
                  status: "available",
                  security: false,
                  held: false,
                  candidateVerified: true,
                  release: "bun",
              }
            : { ...item, imageTag: "stable" };
        const state = await fixture(configured, original);
        try {
            const control = updateControl(configured, state.report, original);
            expect(control.allowed).toBe(true);
            await state.caller.updates.request({
                target: configured.id,
                item: original.id,
                revision: control.revision,
                requestId: crypto.randomUUID(),
            });
            const candidate: UpdateItem = {
                ...original,
                ...(mode === "docker-channel"
                    ? { imageTag: "alpine" }
                    : { release: "node" as const }),
            };
            const observation = { ...state.report, items: [candidate] };
            await state.client`UPDATE operation_snapshots SET value=${JSON.stringify(observation)}::text::jsonb WHERE key IN ('updates:demo','updates.resolved:demo')`;
            const rejected = updateControl(configured, observation, candidate);
            expect(rejected.change).toBe("minor");
            expect(rejected.allowed).toBe(false);
            await expectOperationFailure(
                state.caller.updates.request({
                    target: configured.id,
                    item: candidate.id,
                    revision: rejected.revision,
                    requestId: crypto.randomUUID(),
                }),
                "configured update target"
            );
            await expectOperationFailure(state.run(state.handlers[0]!), "changed");
            await writeUpdatePolicy(state.client, configured, "human:operator", {
                enabled: true,
                version: 0,
            });
            const automatic = state.handlers.find(
                (handler) => handler.definition.key === "updates.automatic"
            )!;
            await state.client.begin(async (transaction) => {
                await lockQueue(transaction);
                await enqueueJob(
                    transaction,
                    automatic.definition,
                    "system:test",
                    crypto.randomUUID()
                );
            });
            await state.run(automatic);
            const [queued] = await state.client<
                { count: number }[]
            >`SELECT count(*)::int AS count FROM job_runs WHERE action=${state.handlers[0]!.definition.key} AND state='queued'`;
            expect(queued?.count).toBe(0);
            expect(state.calls).toHaveLength(0);
        } finally {
            await state.close();
        }
    }
);

test("deployment-owned channel changes invalidate policy consent and native providers are required", async () => {
    const state = await fixture();
    try {
        await writeUpdatePolicy(state.client, target, "human:operator", {
            enabled: true,
            version: 0,
        });
        const [changed] = parseUpdateTargets(
            JSON.stringify([
                { ...target, driver: { ...target.driver, trackingTag: "stable" } },
            ])
        );
        const policies = await readUpdatePolicies(state.client, [changed!]);
        expect(policies[0]).toMatchObject({ enabled: false, configurationChanged: true });
        expect(
            updateControl(target, state.report, { ...item, imageTag: "stable" }).allowed
        ).toBe(false);
        expect(() =>
            parseUpdateTargets(
                JSON.stringify([
                    {
                        ...target,
                        driver: {
                            kind: "native",
                            item: "runtime:demo",
                            inspect: ["/bin/demo", "--version"],
                            install: ["/bin/demo", "install", "{version}"],
                            health: ["/bin/demo", "health"],
                        },
                    },
                ])
            )
        ).toThrow();
    } finally {
        await state.close();
    }
});

test("version classification includes pinned Docker minors without granting latest tags or prereleases automatic major bypass", () => {
    expect(updateChange(item)).toBe("minor");
    expect(updateChange({ ...item, availableImage: item.image })).toBe("patch");
    expect(
        updateChange({
            ...item,
            image: "example/web:latest",
            availableImage: "example/web:latest",
        })
    ).toBe("unknown");
    expect(
        updateChange({
            ...item,
            image: "example/web:latest",
            installedVersion: "1.2.3",
            availableVersion: "1.3.0",
        })
    ).toBe("minor");
    expect(
        updateChange({ ...item, installedVersion: "1.2.3", availableVersion: "2.0.0" })
    ).toBe("major");
    expect(
        updateChange({ ...item, installedVersion: "2.0.0", availableVersion: "1.3.0" })
    ).toBe("unknown");
    expect(
        updateChange({
            ...item,
            installedVersion: "1.2.3-rc.1",
            availableVersion: "1.3.0",
        })
    ).toBe("unknown");
    expect(
        updateChange({
            ...item,
            kind: "os",
            installed: "2:18.5-1.pgdg13+1",
            available: "2:18.6-1.pgdg13+2",
        })
    ).toBe("minor");
    expect(
        updateChange({ ...item, kind: "os", installed: "18.6-1", available: "19.0-1" })
    ).toBe("major");
});

test("Compose environment recipes are explicit, validated and invalidate automatic consent", async () => {
    const state = await fixture();
    try {
        await writeUpdatePolicy(state.client, target, "operator", {
            enabled: true,
            version: 0,
        });
        const environment = {
            command: ["/fixture/secret-reader", "json"],
            variables: ["APP_PASSWORD"],
        };
        const [changed] = parseUpdateTargets(
            JSON.stringify([{ ...target, driver: { ...target.driver, environment } }])
        );
        expect(changed).toBeDefined();
        const policies = await readUpdatePolicies(state.client, [changed!]);
        expect(policies[0]).toMatchObject({ enabled: false, configurationChanged: true });
        expect(updateTargetRevision(changed!)).not.toBe(updateTargetRevision(target));
        expect(JSON.stringify(policies)).not.toContain("secret-reader");
    } finally {
        await state.close();
    }
});

function configuredEnvironment(environment: unknown) {
    return parseUpdateTargets(
        JSON.stringify([{ ...target, driver: { ...target.driver, environment } }])
    );
}

test("Compose environment cannot override process or Docker CLI controls", () => {
    for (const name of [
        "PATH",
        "HOME",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "PYTHONPATH",
        "BASH_ENV",
        "SHELLOPTS",
        "COMPOSE_FILE",
        "DOCKER_HOST",
        "LC_ALL",
        "ENV",
        "IFS",
        "bad-name",
    ])
        expect(() =>
            configuredEnvironment({ command: ["/fixture/reader"], variables: [name] })
        ).toThrow();
    for (const environment of [
        { command: ["relative-reader"], variables: ["APP_PASSWORD"] },
        { command: [], variables: ["APP_PASSWORD"] },
        { command: ["/fixture/reader"], variables: [] },
        { command: ["/fixture/reader"], variables: ["APP_PASSWORD", "APP_PASSWORD"] },
        { command: ["/fixture/reader"], variables: ["APP_PASSWORD"], extra: true },
    ])
        expect(() => configuredEnvironment(environment)).toThrow();
});

test("SSH update transport pins trust and deployment configuration rejects ambiguous targets", () => {
    const args = updateSshArguments(target);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("IdentityAgent=none");
    expect(args).toContain("ClearAllForwardings=yes");
    expect(args.at(-2)).toBe("fixture.invalid");
    expect(args.at(-1)).toStartWith("/usr/bin/python3 -c '");
    expect(() => parseUpdateTargets(JSON.stringify([target, target]))).toThrow("unique");
    expect(() =>
        parseUpdateTargets(JSON.stringify([{ ...target, host: "bad;command" }]))
    ).toThrow();
    expect(() =>
        parseUpdateTargets(
            JSON.stringify([{ ...target, identityFile: "/run/../private" }])
        )
    ).toThrow();
    expect(() =>
        parseUpdateTargets(
            JSON.stringify([
                {
                    ...target,
                    driver: {
                        kind: "native",
                        item: "runtime:demo",
                        release: "bun",
                        inspect: ["/bin/demo", "--version"],
                        install: ["/bin/demo", "upgrade"],
                        health: ["/bin/demo", "health"],
                    },
                },
            ])
        )
    ).toThrow("exact approved version");
});

test.each([
    {
        application: "adguard-home",
        binary: "/opt/AdGuardHome/AdGuardHome",
        service: "AdGuardHome.service",
    },
    {
        application: "openclaw",
        command: ["/usr/local/bin/openclaw"],
        service: "openclaw-gateway.service",
    },
    {
        application: "nextcloud",
        directory: "/srv/nextcloud",
        php: "/usr/bin/php",
        user: "www-data",
    },
])(
    "native recipe $application is compact, provider-owned and part of consent",
    (recipe) => {
        const configured = {
            ...target,
            driver: {
                kind: "native",
                item: "application:fixture",
                release: recipe.application,
                recipe,
                health: ["/usr/local/bin/check-health"],
            },
        };
        const [parsed] = parseUpdateTargets(JSON.stringify([configured]));
        expect(JSON.stringify(parsed?.driver)).toBe(JSON.stringify(configured.driver));
        if (!parsed) throw new Error("Fixture target missing");
        expect(updateSshArguments(parsed).at(-1)).toContain("install_native_recipe");
        expect(() =>
            parseUpdateTargets(
                JSON.stringify([
                    { ...configured, driver: { ...configured.driver, release: "bun" } },
                ])
            )
        ).toThrow("official release provider");
        const [changed] = parseUpdateTargets(
            JSON.stringify([
                {
                    ...configured,
                    driver: {
                        ...configured.driver,
                        health: ["/usr/local/bin/different-health"],
                    },
                },
            ])
        );
        if (!changed) throw new Error("Fixture target missing");
        expect(updateTargetRevision(parsed)).not.toBe(updateTargetRevision(changed));
        expect(JSON.stringify(configured).length).toBeLessThan(1000);
    }
);
