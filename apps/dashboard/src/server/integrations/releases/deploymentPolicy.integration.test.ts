import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { appRouter } from "../../api/router";
import { claimJob, commitClaim, settleClaim } from "../../jobs/claims";
import { createJobRegistry } from "../../jobs/registry";
import { operationFixture, expectOperationFailure } from "../../testing/operations";
import { automaticDeploymentJobs } from "./deploymentAutomatic";
import { coordinateDeployment } from "./deploymentCoordinator";
import {
    deploymentTestConnections as connections,
    deploymentTestTarget as target,
    deploymentTestPlan,
} from "./deploymentFixtures";
import { type DeploymentHostRequest, deploymentDigest } from "./deploymentProtocol";
import type { readHomelabRelease } from "./read";

async function fixture(selectedTarget = target, selectedConnections = connections) {
    const target = selectedTarget;
    const connections = selectedConnections;
    const state = await operationFixture();
    const plan = deploymentTestPlan(target, connections);
    plan.release.dashboardSchema = "f".repeat(64);
    for (const current of Object.values(plan.expected.containers))
        current.dashboardSchema = plan.release.dashboardSchema;
    if (plan.authExpected) {
        plan.release.authSchema = "c".repeat(64);
        for (const current of Object.values(plan.authExpected.containers))
            current.authSchema = plan.release.authSchema;
    }
    const calls: DeploymentHostRequest[] = [];
    let verified = true;
    let reads = 0,
        afterRead: (() => Promise<void>) | undefined,
        afterInspect: (() => Promise<void>) | undefined;
    const read = async () => {
        reads++;
        await afterRead?.();
        return {
            ...plan.release,
            browser: null,
            computer: null,
            tests: "success",
            verified,
            url: "https://github.com/demo/homelab/releases/tag/v1.2.3",
            buildUrl: null,
        } as Awaited<ReturnType<typeof readHomelabRelease>>;
    };
    const host = async (_connection: unknown, request: DeploymentHostRequest) => {
        calls.push(request);
        if (request.mode === "inspect") {
            await afterInspect?.();
            return request.target.id === target.auth?.id
                ? plan.authExpected!
                : plan.expected;
        }
        if (request.mode === "submit") return { state: "running" };
        if (request.mode !== "status") throw new Error("Unexpected host request");
        return {
            id: request.id,
            state: "succeeded",
            phase: "complete",
            requestHash: deploymentDigest({
                id: request.id,
                target,
                release: plan.release,
                expected: plan.expected,
            }),
            updatedAt: Date.now() / 1000,
            changesStarted: true,
            migrationStarted: true,
            version: plan.release.version,
            revision: plan.release.revision,
            containers: Object.fromEntries(
                target.services.map((service) => [
                    service.name,
                    {
                        ...plan.expected.containers[service.name],
                        image: plan.release.images.find(
                            (image) => image.app === service.app
                        )!.reference,
                    },
                ])
            ),
        };
    };
    const registry = createJobRegistry(
        automaticDeploymentJobs({
            client: state.client,
            targets: [target],
            connections,
            repository: "demo/homelab",
            read,
            host,
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
    const policy = async () => {
        const overview = await caller.releases.deployment.overview();
        return overview.targets[0]!.policy;
    };
    const enable = async () => {
        const current = await policy(),
            start = new Date(Date.now() - 5 * 60_000);
        await caller.releases.deployment.policy({
            target: target.id,
            version: current.version,
            mode: "patch",
            window: {
                start: `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`,
                minutes: 60,
            },
        });
    };
    const pause = async () => {
        const current = await policy();
        return caller.releases.deployment.pause({
            target: target.id,
            version: current.version,
            paused: true,
            reason: "Maintenance",
            until: null,
        });
    };
    const check = async () => {
        await caller.jobs.run({
            action: "homelab.automatic",
            requestId: crypto.randomUUID(),
        });
        const run = (await claimJob(state.client, worker, ["homelab.automatic"]))!;
        expect(run).toBeDefined();
        await registry.get(run.action)!.execute(run.payload, {
            runId: run.id,
            leaseToken: run.lease_token,
            signal: AbortSignal.timeout(5000),
            reportProgress: () => Promise.resolve(),
            commit: (write, admission) =>
                commitClaim(state.client, run, write, admission),
        });
        await settleClaim(state.client, run, "succeeded");
    };
    const record = async () => {
        const [row] = await state.client<
            {
                id: string;
                state: string;
                finished: boolean;
                policyVersion: number;
                windowEndsAt: Date;
                phase: string;
            }[]
        >`SELECT id,state,finished_at IS NOT NULL AS finished,policy_version AS "policyVersion",window_ends_at AS "windowEndsAt",phase FROM release_deployments ORDER BY id DESC LIMIT 1`;
        return row;
    };
    const coordinate = () =>
        coordinateDeployment({
            client: state.client,
            controller: worker,
            signal: AbortSignal.timeout(5000),
            targets: [target],
            connections,
            repository: "demo/homelab",
            host,
            read,
        });
    const drain = async () => {
        const current = (await record())!;
        await state.client`UPDATE workers SET deployment_drained_for=${current.id} WHERE id=${worker}`;
        await state.client`INSERT INTO mira_runtime_status (id,worker_id,version,model,ready,message,heartbeat_at,deployment_drained_for) VALUES (1,${worker},'1.2.2','test',false,'Paused',now(),${current.id}) ON CONFLICT(id) DO UPDATE SET deployment_drained_for=EXCLUDED.deployment_drained_for,heartbeat_at=now()`;
    };
    return {
        ...state,
        operations,
        principal,
        caller,
        worker,
        plan,
        calls,
        policy,
        enable,
        pause,
        check,
        record,
        coordinate,
        drain,
        reads: () => reads,
        unverify: () => {
            verified = false;
        },
        onRead: (fn: () => Promise<void>) => {
            afterRead = fn;
        },
        onInspect: (fn: () => Promise<void>) => {
            afterInspect = fn;
        },
    };
}

test.each(["complete", "missing", "different"])(
    "automatic unified admission requires %s Auth schema evidence and remains pausable",
    async (kind) => {
        const auth = {
            ...target,
            id: "auth",
            connection: "edge",
            mira: false as const,
            services: [{ name: "auth", app: "auth" as const }],
        };
        const state = await fixture({ ...target, auth }, [
            ...connections,
            { ...connections[0]!, id: "edge", host: "auth.example.test" },
        ]);
        try {
            await state.enable();
            if (kind === "missing") delete state.plan.release.authSchema;
            if (kind === "different")
                state.plan.authExpected!.containers.auth!.authSchema = "d".repeat(64);
            await state.check();
            const current = await state.record();
            if (kind !== "complete") {
                expect(current).toBeUndefined();
                return;
            }
            expect(current).toMatchObject({ state: "waiting", finished: false });
            const [row] = await state.client<
                { plan: { authExpected: unknown } }[]
            >`SELECT plan FROM release_deployments WHERE id=${current!.id}`;
            expect(row!.plan.authExpected).toEqual(state.plan.authExpected);
            expect(
                state.calls
                    .filter((call) => call.mode === "inspect")
                    .map((call) => call.target.id)
            ).toEqual(["main", "auth"]);
            await state.pause();
            await state.drain();
            await state.coordinate();
            expect(await state.record()).toMatchObject({
                state: "cancelled",
                finished: true,
            });
            expect(state.calls.some((call) => call.mode === "submit")).toBe(false);
        } finally {
            await state.close();
        }
    }
);

test("automatic deployment defaults to manual and policies require fresh human authority with optimistic versions", async () => {
    const state = await fixture();
    try {
        expect(await state.policy()).toMatchObject({
            mode: "manual",
            version: 0,
            paused: false,
        });
        await state.check();
        expect(state.reads()).toBe(0);
        expect(state.calls).toHaveLength(0);
        const input = {
            target: "main",
            version: 0,
            mode: "patch" as const,
            window: { start: "03:00", minutes: 60 },
        };
        for (const context of [
            { principal: state.principal },
            {
                principal: { ...state.principal, kind: "automation" as const },
                verifyHuman: () => Promise.resolve(state.principal),
            },
            {
                principal: state.principal,
                verifyHuman: () => Promise.resolve({ ...state.principal, id: "changed" }),
            },
            {
                principal: state.principal,
                verifyHuman: () =>
                    Promise.resolve({
                        ...state.principal,
                        capabilities: capabilities.filter(
                            (value) => value !== "updates:configure"
                        ),
                    }),
            },
        ])
            await expectOperationFailure(
                appRouter
                    .createCaller({ operations: state.operations, ...context })
                    .releases.deployment.policy(input),
                ""
            );
        await state.enable();
        await expectOperationFailure(
            state.caller.releases.deployment.policy(input),
            "policy changed"
        );
        await state.pause();
        const paused = await state.policy();
        await state.caller.releases.deployment.policy({
            ...input,
            version: paused.version,
        });
        expect(await state.policy()).toMatchObject({
            paused: true,
            reason: "Maintenance",
        });
        await expectOperationFailure(
            state.caller.releases.deployment.pause({
                target: "main",
                version: paused.version,
                paused: false,
                reason: null,
                until: null,
            }),
            "policy changed"
        );
        await expectOperationFailure(
            state.caller.releases.deployment.pause({
                target: "main",
                version: paused.version + 1,
                paused: true,
                reason: "Test",
                until: Date.now() - 1000,
            }),
            "future"
        );
        await state.check();
        expect(state.reads()).toBe(0);
    } finally {
        await state.close();
    }
});

test("a qualified automatic release uses the durable drain and completion path once", async () => {
    const state = await fixture();
    try {
        await state.enable();
        await state.check();
        const run = (await state.record())!;
        expect(run).toMatchObject({
            state: "waiting",
            policyVersion: 1,
            finished: false,
        });
        expect(state.calls[0]).toMatchObject({ mode: "inspect", allowCurrent: true });
        await state.coordinate();
        expect(state.calls.some((call) => call.mode === "submit")).toBe(false);
        await state.drain();
        await state.coordinate();
        expect(await state.record()).toMatchObject({
            state: "succeeded",
            finished: true,
        });
        expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(1);
        await state.check();
        expect(state.calls.filter((call) => call.mode === "inspect")).toHaveLength(1);
        const deployments = await state.client<
            { id: string }[]
        >`SELECT id FROM release_deployments`;
        expect(deployments).toHaveLength(1);
    } finally {
        await state.close();
    }
});

test.each(["pause", "window", "publication race"])(
    "automatic %s changes cancel before host submission",
    async (kind) => {
        const state = await fixture();
        try {
            await state.enable();
            await state.check();
            await state.drain();
            if (kind === "pause") await state.pause();
            else if (kind === "window")
                await state.client`UPDATE release_deployments SET window_ends_at=now()-interval '1 second'`;
            else
                state.onRead(async () => {
                    await state.pause();
                });
            await state.coordinate();
            expect(await state.record()).toMatchObject({
                state: "cancelled",
                finished: true,
                phase: "policy",
            });
            expect(state.calls.some((call) => call.mode === "submit")).toBe(false);
        } finally {
            await state.close();
        }
    }
);

test("pausing during read-only inspection prevents automatic admission", async () => {
    const state = await fixture();
    try {
        await state.enable();
        state.onInspect(async () => {
            await state.pause();
        });
        await state.check();
        expect(await state.record()).toBeUndefined();
    } finally {
        await state.close();
    }
});

test("timed pauses resume under the same scope while authority or timezone changes need renewed consent", async () => {
    const state = await fixture();
    try {
        await state.enable();
        await state.caller.releases.deployment.pause({
            target: "main",
            version: 1,
            paused: true,
            reason: "Sleep",
            until: Date.now() + 60_000,
        });
        await state.check();
        expect(state.reads()).toBe(0);
        await state.client`UPDATE release_deployment_policies SET disabled_until=now()-interval '1 second'`;
        expect(await state.policy()).toMatchObject({
            paused: false,
            reason: null,
            until: null,
        });
        await state.client`UPDATE release_deployment_policies SET configuration=${"0".repeat(64)}`;
        await state.check();
        expect(state.reads()).toBe(0);
        const changedPolicy = await state.policy();
        expect(changedPolicy.configurationChanged).toBe(true);
        await state.enable();
        await state.client`UPDATE release_deployment_policies SET time_zone='Pacific/Honolulu'`;
        await state.check();
        expect(state.reads()).toBe(0);
        await state.enable();
        await state.check();
        expect(await state.record()).toMatchObject({ state: "waiting" });
    } finally {
        await state.close();
    }
});

test.each(["current", "schema changed", "schema missing"])(
    "%s candidates stay quiet and require no automatic host changes",
    async (kind) => {
        const state = await fixture();
        try {
            await state.enable();
            if (kind === "current") state.plan.release.version = "1.2.2";
            else if (kind === "schema changed")
                state.plan.expected.containers.mira!.dashboardSchema = "0".repeat(64);
            else delete state.plan.release.dashboardSchema;
            await state.check();
            expect(await state.record()).toBeUndefined();
            expect(state.calls.every((call) => call.mode === "inspect")).toBe(true);
        } finally {
            await state.close();
        }
    }
);

test("failed automatic candidates cannot be silently retried and explicit cancellation is not replayed in the same window", async () => {
    const state = await fixture();
    try {
        await state.enable();
        await state.check();
        await state.client`UPDATE release_deployments SET state='failed',finished_at=now()`;
        await state.check();
        expect(state.calls).toHaveLength(1);
        await state.client`UPDATE release_deployments SET state='cancelled'`;
        await state.check();
        expect(state.calls).toHaveLength(1);
        const deployments = await state.client<
            { id: string }[]
        >`SELECT id FROM release_deployments`;
        expect(deployments).toHaveLength(1);
    } finally {
        await state.close();
    }
});

test("a submitted automatic deployment finishes even if its policy is paused afterward", async () => {
    const state = await fixture();
    try {
        await state.enable();
        await state.check();
        await state.client`UPDATE release_deployments SET state='submitting'`;
        await state.pause();
        await state.coordinate();
        expect(await state.record()).toMatchObject({
            state: "succeeded",
            finished: true,
        });
        expect(state.calls.filter((call) => call.mode === "submit")).toHaveLength(0);
    } finally {
        await state.close();
    }
});

test("a user-started automatic check cannot bypass the maintenance window or a disabled policy", async () => {
    const state = await fixture();
    try {
        await state.enable();
        const policy = await state.policy();
        const later = new Date(Date.now() + 3 * 3_600_000);
        await state.caller.releases.deployment.policy({
            target: "main",
            version: policy.version,
            mode: "minor",
            window: {
                start: `${String(later.getHours()).padStart(2, "0")}:${String(later.getMinutes()).padStart(2, "0")}`,
                minutes: 15,
            },
        });
        await state.check();
        expect(state.reads()).toBe(0);
        expect(state.calls).toHaveLength(0);
    } finally {
        await state.close();
    }
});

test("unverified release builds wait quietly without invoking the host", async () => {
    const state = await fixture();
    try {
        await state.enable();
        state.unverify();
        await state.check();
        expect(state.calls).toHaveLength(0);
        expect(await state.record()).toBeUndefined();
    } finally {
        await state.close();
    }
});
