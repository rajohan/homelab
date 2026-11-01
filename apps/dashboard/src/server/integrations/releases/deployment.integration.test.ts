import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { runWorker } from "../../../worker/runtime";
import { appRouter } from "../../api/router";
import { claimJob, commitClaim, settleClaim } from "../../jobs/claims";
import { setWorkerControl } from "../../jobs/control";
import { enqueueJob, lockQueue } from "../../jobs/queue";
import { createJobRegistry } from "../../jobs/registry";
import { operationFixture, expectOperationFailure } from "../../testing/operations";
import { authReleaseObservations } from "./authObservations";
import { coordinateDeployment } from "./deploymentCoordinator";
import {
    deploymentTestConnections,
    deploymentTestTarget,
    deploymentTestPlan,
} from "./deploymentFixtures";
import { deploymentPreparationJobs } from "./deploymentPlans";
import {
    deploymentDigest,
    type DeploymentHostRequest,
    type DeploymentObservation,
    type DeploymentReceipt,
} from "./deploymentProtocol";
import type { readHomelabRelease } from "./read";

const target = deploymentTestTarget;

test("Auth version uses a verified deployment before inventory catches up, including Main failure", async () => {
    const state = await fixture(true);
    try {
        const source = state.operations.updateTargets.find(
            (entry) => entry.id === "edge"
        )!.source;
        const report = {
            capturedAt: new Date(Date.now() - 60_000).toISOString(),
            repositoryMetadataAt: null,
            complete: true,
            coveredKinds: ["container"],
            items: [
                {
                    id: `docker:${state.plan.authExpected!.containers.auth!.id}`,
                    name: "Auth",
                    kind: "container",
                    installed: "old",
                    available: null,
                    status: "unknown",
                    image: "ghcr.io/demo/homelab/auth:1.2.2",
                    installedVersion: "1.2.2",
                },
            ],
        };
        await state.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES (${`updates:${source}`},${JSON.stringify(report)}::text::jsonb,now())`;
        const read = async () => {
            const observations = await authReleaseObservations({
                client: state.client,
                repository: "demo/homelab",
                sources: [{ id: source, label: "Auth host", publisher: "test" }],
                targets: [state.target],
                connections: state.operations.updateTargets,
            });
            return observations.map((item) => item.version);
        };
        expect(await read()).toEqual(["1.2.2"]);
        const { id } = await state.request();
        await state.drained(id);
        await state.coordinate();
        expect(await read()).toEqual(["1.2.2"]);
        completeHost(state, true);
        await state.coordinate();
        expect(await read()).toEqual(["1.2.3"]);
        await state.coordinate();
        state.setReceipt({ state: "failed", phase: "failed", recovered: true });
        await state.coordinate();
        const record = await state.record();
        expect(record.state).toBe("failed");
        expect(await read()).toEqual(["1.2.3"]);
        const [row] = await state.client<
            { receipt: unknown; configuration: string }[]
        >`SELECT receipt,configuration FROM release_deployments WHERE id=${id}`;
        for (const field of ["requestHash", "version", "state"]) {
            await state.client`UPDATE release_deployments SET receipt=jsonb_set(receipt,${`{auth,${field}}`}::text[],'"invalid"'::jsonb) WHERE id=${id}`;
            expect(await read()).toEqual(["1.2.2"]);
            await state.client`UPDATE release_deployments SET receipt=${JSON.stringify(row!.receipt)}::text::jsonb WHERE id=${id}`;
        }
        await state.client`UPDATE release_deployments SET configuration=${"f".repeat(64)} WHERE id=${id}`;
        expect(await read()).toEqual(["1.2.2"]);
        await state.client`UPDATE release_deployments SET configuration=${row!.configuration} WHERE id=${id}`;
        report.capturedAt = new Date().toISOString();
        report.items[0]!.installedVersion = "1.2.4";
        await state.client`UPDATE operation_snapshots SET value=${JSON.stringify(report)}::text::jsonb WHERE key=${`updates:${source}`}`;
        expect(await read()).toEqual(["1.2.4"]);
    } finally {
        await state.close();
    }
});

function completeHost(state: Awaited<ReturnType<typeof fixture>>, auth = false) {
    const selected = auth ? state.target.auth! : state.target;
    const expected = auth ? state.plan.authExpected! : state.plan.expected;
    state.setReceipt(
        {
            state: "succeeded",
            phase: "complete",
            changesStarted: true,
            migrationStarted: true,
            version: state.plan.release.version,
            revision: state.plan.release.revision,
            containers: Object.fromEntries(
                selected.services.map((service) => [
                    service.name,
                    {
                        ...expected.containers[service.name]!,
                        image: state.plan.release.images.find(
                            (image) => image.app === service.app
                        )!.reference,
                    },
                ])
            ),
        },
        selected.id
    );
}

async function fixture(includeAuth = false) {
    const connections = includeAuth
        ? [
              ...deploymentTestConnections,
              {
                  ...deploymentTestConnections[0]!,
                  id: "edge",
                  host: "auth.example.test",
              },
          ]
        : deploymentTestConnections;
    const target = includeAuth
        ? {
              ...deploymentTestTarget,
              auth: {
                  ...deploymentTestTarget,
                  id: "auth",
                  connection: "edge",
                  mira: false as const,
                  services: [{ name: "auth", app: "auth" as const }],
              },
          }
        : deploymentTestTarget;
    const state = await operationFixture();
    const plan = deploymentTestPlan(target, connections);
    const calls: DeploymentHostRequest[] = [];
    const receipts = new Map<string, DeploymentReceipt>();
    let lostSubmit = false;
    let authObservation: DeploymentObservation | Error | undefined;
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
        const before = request.target.id === "auth" ? plan.authExpected! : plan.expected;
        const previous = receipts.get(request.target.id);
        if (request.mode === "inspect") {
            if (request.target.id === "auth" && authObservation) {
                if (authObservation instanceof Error)
                    return Promise.reject(authObservation);
                if (
                    !request.allowCurrent &&
                    authObservation.containers.auth!.image !==
                        before.containers.auth!.image
                )
                    return Promise.reject(new Error("release_not_newer"));
                return Promise.resolve(authObservation);
            }
            return Promise.resolve(
                request.allowCurrent && previous?.state === "succeeded"
                    ? { ...before, containers: previous.containers }
                    : before
            );
        }
        if (request.mode === "submit") {
            receipts.set(request.target.id, {
                state: "running",
                id: request.id,
                requestHash: deploymentDigest({
                    id: request.id,
                    target: request.target,
                    release: plan.release,
                    expected: request.expected,
                }),
                phase: "accepted",
                updatedAt: Date.now() / 1000,
                changesStarted: false,
                migrationStarted: false,
            });
            if (lostSubmit) return Promise.reject(new Error("Lost SSH acknowledgement"));
        }
        return Promise.resolve(
            receipts.get(request.target.id) ?? { state: "absent", id: request.id }
        );
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
    const executePreparation = async (beforeCommit?: () => Promise<void>) => {
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
            commit: async (write, admission) => {
                await beforeCommit?.();
                return commitClaim(state.client, run, write, admission);
            },
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
        target,
        plan,
        calls,
        request,
        executePreparation,
        coordinate,
        drained,
        observeAuth: (value: DeploymentObservation | Error) => {
            authObservation = value;
        },
        loseSubmit: () => {
            lostSubmit = true;
        },
        changePublication: () => {
            published = { ...published, version: "1.2.4" };
        },
        setReceipt: (
            update: Partial<Exclude<DeploymentReceipt, { state: "absent" }>>,
            hostId = target.id
        ) => {
            receipts.set(hostId, {
                ...receipts.get(hostId),
                ...update,
            } as DeploymentReceipt);
        },
        record: async () => {
            const [record] = await state.client<
                { state: string; finished: boolean; phase: string }[]
            >`SELECT state,phase,finished_at IS NOT NULL AS finished FROM release_deployments ORDER BY id DESC LIMIT 1`;
            return record!;
        },
    };
}

test.each([false, true])(
    "unified deployment verifies Auth before replacing Main and survives lost SSH: %s",
    async (lost) => {
        const state = await fixture(true);
        try {
            const { id } = await state.request();
            await state.drained(id);
            if (lost) state.loseSubmit();
            await state.coordinate();
            expect(
                state.calls
                    .filter((call) => call.mode === "submit")
                    .map((call) => call.target.id)
            ).toEqual(["auth"]);
            if (lost)
                expect(await state.record()).toMatchObject({
                    state: "unknown",
                    finished: false,
                });
            await state.coordinate();
            expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(1);
            completeHost(state, true);
            await state.coordinate();
            expect(await state.record()).toMatchObject({
                state: "running",
                phase: "auth_complete",
                finished: false,
            });
            await expectOperationFailure(
                state.caller.releases.deployment.cancel({ id }),
                "Only a deployment waiting"
            );
            await state.coordinate();
            expect(
                state.calls
                    .filter((call) => call.mode === "submit")
                    .map((call) => call.target.id)
            ).toEqual(["auth", "main"]);
            await state.coordinate();
            expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(2);
            completeHost(state);
            await state.coordinate();
            expect(await state.record()).toMatchObject({
                state: "succeeded",
                finished: true,
            });
            const [row] = await state.client<
                { receipt: { auth: DeploymentReceipt; main: DeploymentReceipt } }[]
            >`SELECT receipt FROM release_deployments WHERE id=${id}`;
            expect(row!.receipt.auth.state).toBe("succeeded");
            expect(row!.receipt.main.state).toBe("succeeded");
        } finally {
            await state.close();
        }
    }
);

test.each(["auth", "main"])(
    "unified deployment records a recovered %s failure without claiming total success",
    async (hostId) => {
        const state = await fixture(true);
        try {
            const { id } = await state.request();
            await state.drained(id);
            await state.coordinate();
            if (hostId === "main") {
                completeHost(state, true);
                await state.coordinate();
                await state.coordinate();
            }
            state.setReceipt(
                {
                    state: "failed",
                    phase: "failed",
                    changesStarted: false,
                    migrationStarted: false,
                    recovered: true,
                },
                hostId
            );
            await state.coordinate();
            expect(await state.record()).toMatchObject({
                state: "failed",
                finished: true,
            });
            expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(
                hostId === "auth" ? 1 : 2
            );
            const [row] = await state.client<
                { message: string }[]
            >`SELECT message FROM release_deployments WHERE id=${id}`;
            if (hostId === "main") expect(row!.message).toContain("Auth was updated");
        } finally {
            await state.close();
        }
    }
);

test("unified deployment refuses missing Auth completion and holds uncertain recovery", async () => {
    const state = await fixture(true);
    try {
        const { id } = await state.request();
        await state.drained(id);
        await state.coordinate();
        state.setReceipt(
            {
                state: "failed",
                phase: "failed",
                migrationStarted: true,
                recovered: false,
            },
            "auth"
        );
        await state.coordinate();
        expect(await state.record()).toMatchObject({ state: "failed", finished: false });
        await state.client`UPDATE release_deployments SET receipt='{"stage":"main","submitted":false}'::jsonb WHERE id=${id}`;
        await state.coordinate();
        expect(await state.record()).toMatchObject({ state: "unknown", finished: false });
        expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(1);
    } finally {
        await state.close();
    }
});

function currentAuth(state: Awaited<ReturnType<typeof fixture>>): DeploymentObservation {
    return {
        ...state.plan.authExpected!,
        containers: {
            auth: {
                ...state.plan.authExpected!.containers.auth!,
                image: state.plan.release.images.find((image) => image.app === "auth")!
                    .reference,
            },
        },
    };
}

test("unified deployment permits a healthy Auth container recreation during handoff", async () => {
    const state = await fixture(true);
    try {
        const { id } = await state.request();
        await state.drained(id);
        await state.coordinate();
        completeHost(state, true);
        await state.coordinate();
        const observed = currentAuth(state);
        observed.containers.auth!.id = "f".repeat(64);
        observed.units["homelab.service"]!.invocation = "f".repeat(32);
        state.observeAuth(observed);
        await state.coordinate();
        expect(
            state.calls
                .filter((call) => call.mode === "submit")
                .map((call) => call.target.id)
        ).toEqual(["auth", "main"]);
        completeHost(state);
        await state.coordinate();
        expect(await state.record()).toMatchObject({
            state: "succeeded",
            finished: true,
        });
    } finally {
        await state.close();
    }
});

test.each(["image", "unreachable"])(
    "unified handoff ends safely when Auth is %s before Main starts",
    async (failure) => {
        const state = await fixture(true);
        try {
            const { id } = await state.request();
            await state.drained(id);
            await state.coordinate();
            completeHost(state, true);
            await state.coordinate();
            const observed = currentAuth(state);
            observed.containers.auth!.imageId = `sha256:${"f".repeat(64)}`;
            state.observeAuth(
                failure === "unreachable" ? new Error("SSH unavailable") : observed
            );
            await state.coordinate();
            expect(await state.record()).toMatchObject({
                state: "failed",
                phase: "auth_verification",
                finished: true,
            });
            await state.coordinate();
            expect(
                state.calls
                    .filter((call) => call.mode === "submit")
                    .map((call) => call.target.id)
            ).toEqual(["auth"]);
            await state.caller.jobs.run({
                action: "homelab.prepare.main",
                requestId: crypto.randomUUID(),
            });
            expect(
                await claimJob(state.client, state.worker, ["homelab.prepare.main"], true)
            ).toBeDefined();
        } finally {
            await state.close();
        }
    }
);

test.each([false, true])(
    "manual retry preserves existing Auth and submits Main once after lost SSH: prior partial failure %s",
    async (retry) => {
        const state = await fixture(true);
        try {
            if (retry) {
                const { id } = await state.request();
                await state.drained(id);
                await state.coordinate();
                completeHost(state, true);
                await state.coordinate();
                await state.coordinate();
                state.setReceipt({
                    state: "failed",
                    phase: "failed",
                    changesStarted: false,
                    migrationStarted: false,
                    recovered: true,
                });
                await state.coordinate();
                expect(await state.record()).toMatchObject({
                    state: "failed",
                    finished: true,
                });
            } else state.observeAuth(currentAuth(state));
            const { id } = await state.request();
            await state.drained(id);
            state.loseSubmit();
            await state.coordinate();
            expect(await state.record()).toMatchObject({
                state: "unknown",
                finished: false,
            });
            await state.coordinate();
            expect(await state.record()).toMatchObject({
                state: "running",
                finished: false,
            });
            completeHost(state);
            await state.coordinate();
            expect(await state.record()).toMatchObject({
                state: "succeeded",
                finished: true,
            });
            expect(
                state.calls
                    .filter((call) => call.mode === "submit")
                    .map((call) => call.target.id)
            ).toEqual(retry ? ["auth", "main", "main"] : ["main"]);
            const [row] = await state.client<
                { receipt: { authAlreadyCurrent: boolean; auth?: unknown } }[]
            >`SELECT receipt FROM release_deployments WHERE id=${id}`;
            expect(row!.receipt.authAlreadyCurrent).toBe(true);
            expect(row!.receipt.auth).toBeUndefined();
        } finally {
            await state.close();
        }
    }
);

test.each(["different_digest", "newer", "unhealthy"])(
    "manual preparation refuses Auth with %s evidence",
    async (failure) => {
        const state = await fixture(true);
        try {
            const observed = currentAuth(state);
            if (failure === "different_digest")
                observed.containers.auth!.image = observed.containers.auth!.image.replace(
                    "c".repeat(64),
                    "d".repeat(64)
                );
            if (failure === "newer")
                observed.containers.auth!.image = observed.containers.auth!.image.replace(
                    ":1.2.3@",
                    ":1.2.4@"
                );
            if (failure === "unhealthy") observed.containers.auth!.health = "unhealthy";
            state.observeAuth(observed);
            expect(
                await state.executePreparation().then(
                    () => null,
                    (error: unknown) => error
                )
            ).toBeInstanceOf(Error);
            expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(0);
        } finally {
            await state.close();
        }
    }
);

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
        const prepared = await state.executePreparation();
        const input = {
            target: target.id,
            revision: prepared.revision!,
            requestId: crypto.randomUUID(),
        };
        const { id } = await state.caller.releases.deployment.request(input);
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
        const overview = await state.caller.releases.deployment.overview();
        expect(overview.targets[0]?.revision).toBeNull();
        expect(await state.caller.releases.deployment.request(input)).toEqual({ id });
        await expectOperationFailure(
            state.caller.releases.deployment.request({
                ...input,
                requestId: crypto.randomUUID(),
            }),
            "Prepare and confirm"
        );
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

test("accepting a deployment consumes preparation and fences a concurrently completing preparation", async () => {
    const state = await fixture();
    const ready = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let pending: Promise<unknown> | undefined;
    try {
        const prepared = await state.executePreparation();
        pending = state
            .executePreparation(async () => {
                ready.resolve();
                await finish.promise;
            })
            .then(
                () => null,
                (error: unknown) => error
            );
        await ready.promise;
        const input = {
            target: target.id,
            revision: prepared.revision!,
            requestId: crypto.randomUUID(),
        };
        const accepted = await state.caller.releases.deployment.request(input);
        finish.resolve();
        expect(await pending).toBeInstanceOf(Error);
        const overview = await state.caller.releases.deployment.overview();
        expect(overview.targets[0]?.revision).toBeNull();
        await state.caller.releases.deployment.cancel(accepted);
        expect(await state.caller.releases.deployment.request(input)).toEqual(accepted);
        await expectOperationFailure(
            state.caller.releases.deployment.request({
                ...input,
                requestId: crypto.randomUUID(),
            }),
            "Prepare and confirm"
        );
    } finally {
        finish.resolve();
        await pending;
        await state.close();
    }
});
