import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { runWorker } from "../../../worker/runtime";
import { appRouter } from "../../api/router";
import { claimJob, commitClaim, settleClaim } from "../../jobs/claims";
import { setWorkerControl } from "../../jobs/control";
import { enqueueJob, lockQueue } from "../../jobs/queue";
import { createJobRegistry } from "../../jobs/registry";
import { operationFixture, expectOperationFailure } from "../../testing/operations";
import { coordinateDeployment } from "./deploymentCoordinator";
import {
    deploymentTestConnections as connections,
    deploymentTestTarget as target,
    deploymentTestPlan,
} from "./deploymentFixtures";
import { deploymentPreparationJobs } from "./deploymentPlans";
import {
    deploymentDigest,
    type DeploymentHostRequest,
    type DeploymentReceipt,
} from "./deploymentProtocol";
import type { readHomelabRelease } from "./read";

async function fixture() {
    const state = await operationFixture();
    const plan = deploymentTestPlan();
    const calls: DeploymentHostRequest[] = [];
    let receipt: DeploymentReceipt | undefined;
    let lostSubmit = false;
    let published = {
        ...plan.release,
        browser: null,
        computer: null,
        tests: "success",
        verified: true,
        url: "https://github.com/demo/homelab/releases/tag/v1.2.3",
        buildUrl: null,
    };
    const host = (_connection: unknown, request: DeploymentHostRequest) => {
        calls.push(request);
        if (request.mode === "inspect") return Promise.resolve(plan.expected);
        if (request.mode === "submit") {
            receipt = {
                state: "running",
                id: request.id,
                requestHash: deploymentDigest({
                    id: request.id,
                    target,
                    release: plan.release,
                    expected: plan.expected,
                }),
                phase: "accepted",
                updatedAt: Date.now() / 1000,
                changesStarted: false,
                migrationStarted: false,
            };
            if (lostSubmit) return Promise.reject(new Error("Lost SSH acknowledgement"));
        }
        return Promise.resolve(receipt ?? { state: "absent", id: request.id });
    };
    const read = () =>
        Promise.resolve(published as Awaited<ReturnType<typeof readHomelabRelease>>);
    const registry = createJobRegistry(
        deploymentPreparationJobs({
            targets: [target],
            connections,
            repository: "demo/homelab",
            host,
            read,
        })
    );
    const operations = {
        ...state,
        registry,
        deploymentTargets: [target],
        updateTargets: connections,
        releaseRepository: "demo/homelab",
    };
    const principal = { kind: "human" as const, id: "operator", capabilities };
    const caller = appRouter.createCaller({
        operations,
        principal,
        verifyHuman: () => Promise.resolve(principal),
    });
    const worker = await state.registerWorker();
    await state.client`UPDATE workers SET deployment_protocol=1 WHERE id=${worker}`;
    const executePreparation = async () => {
        await caller.jobs.run({
            action: "homelab.prepare.main",
            requestId: crypto.randomUUID(),
        });
        const run = (await claimJob(state.client, worker, ["homelab.prepare.main"]))!;
        await registry.get(run.action)!.execute(run.payload, {
            runId: run.id,
            leaseToken: run.lease_token,
            signal: AbortSignal.timeout(2000),
            reportProgress: () => Promise.resolve(),
            commit: (write, admission) =>
                commitClaim(state.client, run, write, admission),
        });
        await settleClaim(state.client, run, "succeeded");
        const overview = await caller.releases.deployment.overview();
        return overview.targets[0]!;
    };
    const request = async () => {
        const prepared = await executePreparation();
        return caller.releases.deployment.request({
            target: target.id,
            revision: prepared.revision!,
            requestId: crypto.randomUUID(),
        });
    };
    const coordinate = () =>
        coordinateDeployment({
            client: state.client,
            controller: worker,
            signal: AbortSignal.timeout(3000),
            targets: [target],
            connections,
            repository: "demo/homelab",
            host,
            read,
        });
    const drained = async (id: string) => {
        await state.client`UPDATE workers SET deployment_drained_for=${id} WHERE id=${worker}`;
        await state.client`INSERT INTO mira_runtime_status (id,worker_id,version,model,ready,message,heartbeat_at,deployment_drained_for) VALUES (1,${worker},'1.2.2','test',false,'Paused',now(),${id}) ON CONFLICT(id) DO UPDATE SET deployment_drained_for=EXCLUDED.deployment_drained_for,heartbeat_at=now()`;
    };
    return {
        ...state,
        caller,
        operations,
        principal,
        worker,
        plan,
        calls,
        request,
        executePreparation,
        coordinate,
        drained,
        loseSubmit: () => {
            lostSubmit = true;
        },
        changePublication: () => {
            published = { ...published, version: "1.2.4" };
        },
        setReceipt: (
            update: Partial<Exclude<DeploymentReceipt, { state: "absent" }>>
        ) => {
            receipt = { ...receipt, ...update } as DeploymentReceipt;
        },
        record: async () => {
            const [record] = await state.client<
                { state: string; finished: boolean; phase: string }[]
            >`SELECT state,phase,finished_at IS NOT NULL AS finished FROM release_deployments ORDER BY id DESC LIMIT 1`;
            return record!;
        },
    };
}

test("deployment admission requires fresh human authority, current preparation and compatible workers", async () => {
    const state = await fixture();
    try {
        const prepared = await state.executePreparation();
        const input = {
            target: "main",
            revision: prepared.revision!,
            requestId: crypto.randomUUID(),
        };
        for (const context of [
            { principal: { ...state.principal, kind: "automation" as const } },
            { principal: state.principal },
            {
                principal: state.principal,
                verifyHuman: () => Promise.resolve({ ...state.principal, id: "changed" }),
            },
            {
                principal: state.principal,
                verifyHuman: () =>
                    Promise.resolve({ ...state.principal, capabilities: [] }),
            },
        ])
            await expectOperationFailure(
                appRouter
                    .createCaller({ operations: state.operations, ...context })
                    .releases.deployment.request(input),
                ""
            );
        await state.client`UPDATE workers SET deployment_protocol=0 WHERE id=${state.worker}`;
        await expectOperationFailure(
            state.caller.releases.deployment.request(input),
            "deployment-capable"
        );
        await state.client`UPDATE workers SET deployment_protocol=1 WHERE id=${state.worker}`;
        await expectOperationFailure(
            state.caller.releases.deployment.request({
                ...input,
                revision: "0".repeat(64),
            }),
            "Prepare and confirm"
        );
        const first = await state.caller.releases.deployment.request(input);
        expect(await state.caller.releases.deployment.request(input)).toEqual(first);
        await expectOperationFailure(
            state.caller.releases.deployment.request({
                ...input,
                revision: "0".repeat(64),
            }),
            "another deployment"
        );
        await expectOperationFailure(
            state.caller.releases.deployment.request({
                ...input,
                requestId: crypto.randomUUID(),
            }),
            "already requires"
        );
        const publicData = JSON.stringify(
            await state.caller.releases.deployment.overview()
        );
        expect(publicData).not.toContain("/srv/");
        expect(publicData).not.toContain("composeCommand");
        await state.caller.releases.deployment.cancel({ id: first.id });
        expect(await state.record()).toMatchObject({
            state: "cancelled",
            finished: true,
        });
    } finally {
        await state.close();
    }
});

test("deployment freezes ordinary job admission, drains Mira and survives replacement without replay", async () => {
    const state = await fixture();
    try {
        const { id } = await state.request();
        await state.caller.jobs.run({
            action: "homelab.prepare.main",
            requestId: crypto.randomUUID(),
        });
        expect(
            await claimJob(state.client, state.worker, ["homelab.prepare.main"], true)
        ).toBeUndefined();
        await state.coordinate();
        expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(0);
        await state.drained(id);
        state.loseSubmit();
        await state.coordinate();
        expect(await state.record()).toMatchObject({ state: "unknown", finished: false });
        await state.coordinate();
        expect(await state.record()).toMatchObject({ state: "running", finished: false });
        expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(1);
        await expectOperationFailure(
            state.caller.releases.deployment.cancel({ id }),
            "Only a deployment waiting"
        );
        state.setReceipt({
            state: "succeeded",
            phase: "complete",
            changesStarted: true,
            migrationStarted: true,
            version: state.plan.release.version,
            revision: state.plan.release.revision,
            containers: Object.fromEntries(
                target.services.map((service) => [
                    service.name,
                    {
                        ...state.plan.expected.containers[service.name]!,
                        image: state.plan.release.images.find(
                            (image) => image.app === service.app
                        )!.reference,
                    },
                ])
            ),
        });
        await state.coordinate();
        expect(await state.record()).toMatchObject({
            state: "succeeded",
            finished: true,
        });
        expect(
            await claimJob(state.client, state.worker, ["homelab.prepare.main"], true)
        ).toBeDefined();
    } finally {
        await state.close();
    }
});

test.each(["publication", "expired", "cancelled"])(
    "deployment never launches after %s changes",
    async (kind) => {
        const state = await fixture();
        try {
            const { id } = await state.request();
            await state.drained(id);
            if (kind === "publication") state.changePublication();
            if (kind === "expired")
                await state.client`UPDATE release_deployments SET created_at=now()-interval '31 minutes' WHERE id=${id}`;
            if (kind === "cancelled")
                await state.caller.releases.deployment.cancel({ id });
            await state.coordinate();
            expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(0);
            const record = await state.record();
            expect(record.finished).toBe(true);
        } finally {
            await state.close();
        }
    }
);

test("concurrent coordinators serialize submission and retain the gate after migration failure", async () => {
    const state = await fixture();
    try {
        const { id } = await state.request();
        await state.drained(id);
        await Promise.all([state.coordinate(), state.coordinate()]);
        expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(1);
        state.setReceipt({
            state: "failed",
            phase: "failed",
            migrationStarted: true,
            changesStarted: true,
            recovered: false,
        });
        await state.coordinate();
        expect(await state.record()).toMatchObject({ state: "failed", finished: false });
        state.setReceipt({ recovered: true, code: "operator_recovered" });
        await state.coordinate();
        expect(await state.record()).toMatchObject({ state: "failed", finished: true });
    } finally {
        await state.close();
    }
});

test("an invalid completion receipt cannot open the deployment gate", async () => {
    const state = await fixture();
    try {
        const { id } = await state.request();
        await state.drained(id);
        await state.coordinate();
        state.setReceipt({
            state: "succeeded",
            phase: "complete",
            version: "1.2.4",
            revision: "0".repeat(40),
        });
        await state.coordinate();
        expect(await state.record()).toMatchObject({ state: "unknown", finished: false });
    } finally {
        await state.close();
    }
});

test("a worker acknowledges deployment only after local execution and cleanup have stopped", async () => {
    const state = await fixture();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const lifecycle = new AbortController();
    const definition = {
        key: "test.active",
        label: "Synthetic active work",
        description: "Hold synthetic work until cleanup finishes.",
        capability: "jobs:run" as const,
        resourceClass: "interactive" as const,
        resourceKeys: [],
        timeoutMs: 60_000,
        attemptLimit: 1,
        retrySafe: false,
        intervalSeconds: null,
        validate: () => ({}),
    };
    const registry = createJobRegistry([
        {
            definition,
            execute: async () => {
                started.resolve();
                await finish.promise;
            },
        },
    ]);
    let worker: Promise<void> | undefined;
    try {
        const job = await state.client.begin(async (transaction) => {
            await lockQueue(transaction);
            return enqueueJob(
                transaction,
                definition,
                "human:operator",
                crypto.randomUUID(),
                {}
            );
        });
        worker = runWorker({
            client: state.client,
            registry,
            concurrency: 1,
            signal: lifecycle.signal,
            version: "test",
        });
        await started.promise;
        const { id } = await state.request();
        await state.drained(id);
        // Simulate an expired durable claim while its original process still awaits cleanup.
        await state.client`UPDATE job_runs SET state='failed',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,finished_at=now() WHERE id=${job}`;
        await Bun.sleep(5300);
        const [busy] = await state.client<
            { drained: string | null }[]
        >`SELECT deployment_drained_for AS drained FROM workers WHERE id<>${state.worker}`;
        expect(busy?.drained).toBeNull();
        await state.coordinate();
        expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(0);
        finish.resolve();
        for (let attempt = 0; attempt < 60; attempt++) {
            const [current] = await state.client<
                { drained: string | null }[]
            >`SELECT deployment_drained_for AS drained FROM workers WHERE id<>${state.worker}`;
            if (current?.drained === id) break;
            await Bun.sleep(100);
        }
        const [ready] = await state.client<
            { drained: string | null }[]
        >`SELECT deployment_drained_for AS drained FROM workers WHERE id<>${state.worker}`;
        expect(ready?.drained).toBe(id);
    } finally {
        finish.resolve();
        lifecycle.abort();
        await worker;
        await state.close();
    }
}, 20_000);

test("user queue pause remains set after a recovered deployment failure", async () => {
    const state = await fixture();
    try {
        const { id } = await state.request();
        await state.drained(id);
        await setWorkerControl(state.client, "human:operator", {
            version: 1,
            paused: true,
        });
        await state.coordinate();
        state.setReceipt({
            state: "failed",
            phase: "failed",
            changesStarted: true,
            migrationStarted: false,
            recovered: true,
        });
        await state.coordinate();
        expect(await state.record()).toMatchObject({ state: "failed", finished: true });
        const [control] = await state.client<
            { paused: boolean }[]
        >`SELECT paused FROM worker_control WHERE id=1`;
        expect(control?.paused).toBe(true);
    } finally {
        await state.close();
    }
});
