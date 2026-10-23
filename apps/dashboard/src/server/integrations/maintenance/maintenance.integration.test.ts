import { expect, setSystemTime, spyOn, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";

import { appRouter } from "../../api/router";
import { claimJob, commitClaim, settleClaim } from "../../jobs/claims";
import { reportJobProgress } from "../../jobs/progress";
import { createJobRegistry } from "../../jobs/registry";
import { expectOperationFailure, operationFixture } from "../../testing/operations";
import { parseUpdateTargets } from "../updates/configuration";
import {
    recordRestartObservation,
    restartObservationTime,
} from "../updates/restartObservation";
import { parseMaintenanceTargets } from "./configuration";
import type { MaintenanceObservation, MaintenanceProbe } from "./execution";
import { maintenanceJobs } from "./jobs";

const connections = parseUpdateTargets(
    JSON.stringify([
        {
            id: "demo",
            label: "Demo",
            source: "demo",
            host: "host.example.test",
            user: "operator",
            identityFile: "/run/secret/key",
            knownHostsFile: "/run/secret/hosts",
            driver: { kind: "apt" },
        },
    ])
);
const target = {
    id: "web",
    connection: "demo",
    label: "Web",
    impact: "The test web service will be unavailable briefly.",
    kind: "service",
    service: "example.service",
    health: ["/usr/bin/true"],
    workerIndependent: true,
};

test.each([-86_400_000, 86_400_000])(
    "restart observations stay ordered and fresh despite worker clock offset %s",
    async (offset) => {
        const observation: MaintenanceObservation = {
            bootId: Bun.randomUUIDv7(),
            active: "active",
            invocationId: "a".repeat(32),
            rebootRequired: false,
            serviceRestartRequired: false,
            health: true,
        };
        const state = await fixture(() => Promise.resolve(observation));
        try {
            const plan = await state.refresh();
            await state.caller.maintenance.request({
                target: "web",
                revision: plan.revision,
                requestId: Bun.randomUUIDv7(),
            });
            setSystemTime(new Date(Date.now() + offset));
            try {
                await state.execute("maintenance.restart.web");
            } finally {
                setSystemTime();
            }
            const [record] = await state.client<{ age: number; required: boolean }[]>`
                SELECT extract(epoch FROM clock_timestamp() - captured_at)::float AS age,
                    (value->>'required')::boolean AS required
                FROM operation_snapshots WHERE key = 'updates.restart:demo'`;
            expect(record?.age).toBeGreaterThanOrEqual(-1);
            expect(record?.age).toBeLessThan(10);
            expect(record?.required).toBe(false);
            // A later observation must replace the receipt, including after a fast worker clock.
            await recordRestartObservation(
                state.client,
                "demo",
                true,
                await restartObservationTime(state.client)
            );
            const [next] = await state.client<
                { required: boolean }[]
            >`SELECT (value->>'required')::boolean AS required FROM operation_snapshots WHERE key = 'updates.restart:demo'`;
            expect(next?.required).toBe(true);
        } finally {
            setSystemTime();
            await state.close();
        }
    }
);

test("restart authority is disabled by default and requires a qualified fixed recipe", () => {
    expect(parseMaintenanceTargets(undefined, connections)).toEqual([]);
    for (const recipe of [
        { ...target, workerIndependent: false },
        { ...target, connection: "missing" },
        { ...target, health: ["curl", "http://example.test"] },
        { ...target, service: "example.service; reboot" },
        { ...target, kind: "host" },
    ]) {
        expect(() =>
            parseMaintenanceTargets(JSON.stringify([recipe]), connections)
        ).toThrow();
    }
    expect(() =>
        parseMaintenanceTargets(JSON.stringify([target, target]), connections)
    ).toThrow();
});

async function fixture(
    probe: MaintenanceProbe,
    recipe = target,
    connectionSet = connections
) {
    const state = await operationFixture();
    const targets = parseMaintenanceTargets(JSON.stringify([recipe]), connectionSet);
    const registry = createJobRegistry(maintenanceJobs(targets, connectionSet, probe));
    const operations = {
        ...state,
        registry,
        maintenanceTargets: targets,
        updateTargets: connectionSet,
    };
    const principal = { kind: "human" as const, id: "operator", capabilities };
    const caller = appRouter.createCaller({
        operations,
        principal,
        verifyHuman: () => Promise.resolve(principal),
    });
    const worker = await state.registerWorker();
    const execute = async (key: string) => {
        const run = await claimJob(state.client, worker, [key]);
        if (!run) throw new Error("Fixture claim missing");
        const handler = registry.get(key)!;
        try {
            await handler.execute(run.payload, {
                runId: run.id,
                leaseToken: run.lease_token,
                signal: AbortSignal.timeout(6000),
                commit: (write, admission) =>
                    commitClaim(state.client, run, write, admission),
                reportProgress: (message) =>
                    reportJobProgress(state.client, run, message),
            });
            await settleClaim(state.client, run, "succeeded");
        } catch (error) {
            await settleClaim(state.client, run, "failed");
            throw error;
        }
        return run;
    };
    const refresh = async () => {
        await caller.jobs.run({
            action: "maintenance.inspect.web",
            requestId: Bun.randomUUIDv7(),
        });
        await execute("maintenance.inspect.web");
        const plans = await caller.maintenance.plans();
        return plans[0]!;
    };
    return { ...state, operations, principal, caller, execute, refresh };
}

test("restart admission requires current human proof and preserves idempotency and verified results", async () => {
    const observation: MaintenanceObservation = {
        bootId: Bun.randomUUIDv7(),
        active: "active",
        invocationId: "a".repeat(32),
        rebootRequired: false,
        serviceRestartRequired: true,
        health: false,
    };
    const modes: string[] = [];
    const state = await fixture((_connection, _target, mode) => {
        modes.push(mode);
        return Promise.resolve({
            ...observation,
            health: mode !== "inspect",
            serviceRestartRequired: mode === "inspect",
        });
    });
    try {
        const plan = await state.refresh();
        expect(plan.required).toBe(true);
        expect(JSON.stringify(plan)).not.toContain("bootId");
        expect(JSON.stringify(plan)).not.toContain("/run/secret");
        const input = {
            target: "web",
            revision: plan.revision,
            requestId: Bun.randomUUIDv7(),
        };
        const noProof = appRouter.createCaller({
            operations: state.operations,
            principal: state.principal,
        });
        await expectOperationFailure(
            noProof.maintenance.request(input),
            "verified human"
        );
        const machine = appRouter.createCaller({
            operations: state.operations,
            principal: { ...state.principal, kind: "automation" },
        });
        await expectOperationFailure(
            machine.maintenance.request(input),
            "verified human"
        );
        const changedIdentity = appRouter.createCaller({
            operations: state.operations,
            principal: state.principal,
            verifyHuman: () => Promise.resolve({ ...state.principal, id: "different" }),
        });
        await expectOperationFailure(
            changedIdentity.maintenance.request(input),
            "account changed"
        );
        const queued = await state.caller.maintenance.request(input);
        expect(await state.caller.maintenance.request(input)).toEqual(queued);
        await expectOperationFailure(
            state.caller.maintenance.request({ ...input, revision: "0".repeat(64) }),
            "another restart"
        );
        await state.execute("maintenance.restart.web");
        const detail = await state.caller.jobs.detail({ id: queued.id });
        expect(detail.run.state).toBe("succeeded");
        expect(detail.run.results).toEqual([
            {
                label: "Web",
                operation: "service-restart",
                installed: null,
                health: "passed",
                rebootRequired: false,
                warnings: [],
            },
        ]);
        expect(modes.filter((mode) => mode === "restart")).toHaveLength(1);
        expect(await state.caller.maintenance.request(input)).toEqual(queued);
    } finally {
        await state.close();
    }
});

test("two queued confirmations for one service invocation can restart it only once", async () => {
    const bootId = Bun.randomUUIDv7();
    let invocationId = "a".repeat(32);
    let restarts = 0;
    const state = await fixture((_connection, _target, mode) => {
        if (mode === "restart") {
            restarts += 1;
            invocationId = "b".repeat(32);
        }
        return Promise.resolve({
            bootId,
            active: "active",
            invocationId,
            rebootRequired: false,
            serviceRestartRequired: true,
            health: mode !== "inspect",
        });
    });
    try {
        const plan = await state.refresh();
        const other = { ...state.principal, id: "second-operator" };
        const secondCaller = appRouter.createCaller({
            operations: state.operations,
            principal: other,
            verifyHuman: () => Promise.resolve(other),
        });
        const queued = await Promise.all(
            [state.caller, secondCaller].map((caller) =>
                caller.maintenance.request({
                    target: "web",
                    revision: plan.revision,
                    requestId: Bun.randomUUIDv7(),
                })
            )
        );
        await state.execute("maintenance.restart.web");
        await expectOperationFailure(
            state.execute("maintenance.restart.web"),
            "changed since confirmation"
        );
        expect(restarts).toBe(1);
        const details = await Promise.all(
            queued.map(({ id }) => state.caller.jobs.detail({ id }))
        );
        expect(details.map((detail) => detail.run.state).toSorted()).toEqual([
            "failed",
            "succeeded",
        ]);
    } finally {
        await state.close();
    }
});

test.each([undefined, null])(
    "service plans without invocation evidence require fresh inspection (%s)",
    async (invocationId) => {
        const observation: MaintenanceObservation = {
            bootId: Bun.randomUUIDv7(),
            active: "active",
            invocationId: "a".repeat(32),
            rebootRequired: false,
            serviceRestartRequired: true,
            health: false,
        };
        const state = await fixture(() => Promise.resolve(observation));
        try {
            await state.refresh();
            const stale = JSON.stringify({ ...observation, invocationId });
            await state.client`UPDATE operation_snapshots SET value = jsonb_set(value, '{observation}', ${stale}::text::jsonb) WHERE key = 'maintenance:web'`;
            const [plan] = await state.caller.maintenance.plans();
            expect(plan?.allowed).toBe(false);
            await expectOperationFailure(
                state.caller.maintenance.request({
                    target: "web",
                    revision: plan!.revision,
                    requestId: Bun.randomUUIDv7(),
                }),
                "changed"
            );
            const fresh = await state.refresh();
            expect(fresh.allowed).toBe(true);
        } finally {
            await state.close();
        }
    }
);

test("changed or stopped services and expired confirmations never issue a restart", async () => {
    let bootId = Bun.randomUUIDv7();
    let active: "active" | "inactive" = "active";
    let restarts = 0;
    const state = await fixture((_connection, _target, mode) => {
        if (mode === "restart") restarts += 1;
        return Promise.resolve({
            bootId,
            active,
            invocationId: "a".repeat(32),
            rebootRequired: false,
            serviceRestartRequired: null,
            health: false,
        });
    });
    try {
        const plan = await state.refresh();
        await state.caller.maintenance.request({
            target: "web",
            revision: plan.revision,
            requestId: Bun.randomUUIDv7(),
        });
        bootId = Bun.randomUUIDv7();
        await expectOperationFailure(
            state.execute("maintenance.restart.web"),
            "changed since confirmation"
        );
        const next = await state.refresh();
        const pending = await state.caller.maintenance.request({
            target: "web",
            revision: next.revision,
            requestId: Bun.randomUUIDv7(),
        });
        await state.client`UPDATE job_runs SET created_at = now() - interval '6 minutes' WHERE id = ${pending.id}`;
        await expectOperationFailure(state.execute("maintenance.restart.web"), "expired");
        active = "inactive";
        const stopped = await state.refresh();
        expect(stopped.allowed).toBe(false);
        await expectOperationFailure(
            state.caller.maintenance.request({
                target: "web",
                revision: stopped.revision,
                requestId: Bun.randomUUIDv7(),
            }),
            "changed"
        );
        expect(restarts).toBe(0);
    } finally {
        await state.close();
    }
});

test("host reboot succeeds only after a changed boot identity and health verification", async () => {
    const bootId = Bun.randomUUIDv7();
    const nextBoot = Bun.randomUUIDv7();
    let restarting = false;
    const state = await fixture(
        (_connection, _target, mode) => {
            if (mode === "restart") {
                restarting = true;
                throw new Error("SSH disconnected after reboot request");
            }
            return Promise.resolve({
                bootId: restarting ? nextBoot : bootId,
                active: null,
                invocationId: null,
                rebootRequired: !restarting,
                serviceRestartRequired: null,
                health: mode === "verify",
            });
        },
        { ...target, kind: "host", service: undefined } as unknown as typeof target
    );
    try {
        const plan = await state.refresh();
        const queued = await state.caller.maintenance.request({
            target: "web",
            revision: plan.revision,
            requestId: Bun.randomUUIDv7(),
        });
        await state.execute("maintenance.restart.web");
        const detail = await state.caller.jobs.detail({ id: queued.id });
        expect(detail.run.results[0]).toMatchObject({
            operation: "host-restart",
            health: "passed",
            rebootRequired: false,
        });
    } finally {
        await state.close();
    }
});

test("stale plans are refused and shared host leases prevent overlapping restarts without inventing health", async () => {
    const observation: MaintenanceObservation = {
        bootId: Bun.randomUUIDv7(),
        active: "active",
        invocationId: "a".repeat(32),
        rebootRequired: false,
        serviceRestartRequired: true,
        health: false,
    };
    let restarts = 0;
    const state = await fixture((_connection, _target, mode) => {
        if (mode === "restart") restarts += 1;
        return Promise.resolve(observation);
    });
    try {
        const stale = await state.refresh();
        await state.client`UPDATE operation_snapshots SET captured_at = now() - interval '3 minutes' WHERE key = 'maintenance:web'`;
        await expectOperationFailure(
            state.caller.maintenance.request({
                target: "web",
                revision: stale.revision,
                requestId: Bun.randomUUIDv7(),
            }),
            "changed"
        );
        const plan = await state.refresh();
        await state.caller.maintenance.request({
            target: "web",
            revision: plan.revision,
            requestId: Bun.randomUUIDv7(),
        });
        const firstWorker = await state.registerWorker();
        const secondWorker = await state.registerWorker();
        const first = await claimJob(state.client, firstWorker, [
            "maintenance.restart.web",
        ]);
        expect(first).toBeDefined();
        await state.caller.jobs.run({
            action: "maintenance.inspect.web",
            requestId: Bun.randomUUIDv7(),
        });
        expect(
            await claimJob(state.client, secondWorker, ["maintenance.inspect.web"], true)
        ).toBeUndefined();
        const second = await state.caller.maintenance.request({
            target: "web",
            revision: plan.revision,
            requestId: Bun.randomUUIDv7(),
        });
        expect(
            await claimJob(state.client, secondWorker, ["maintenance.restart.web"])
        ).toBeUndefined();
        await settleClaim(state.client, first!, "interrupted");
        await expectOperationFailure(
            state.execute("maintenance.restart.web"),
            "health verification failed"
        );
        const detail = await state.caller.jobs.detail({ id: second.id });
        expect(detail.run.state).toBe("failed");
        expect(detail.run.results).toEqual([]);
        expect(restarts).toBe(1);
        await state.execute("maintenance.inspect.web");
    } finally {
        await state.close();
    }
});

test.each([-86_400_000, 86_400_000])(
    "restart authorization uses database time despite dashboard clock offset %s",
    async (offset) => {
        const observation: MaintenanceObservation = {
            bootId: Bun.randomUUIDv7(),
            active: "active",
            invocationId: "a".repeat(32),
            rebootRequired: false,
            serviceRestartRequired: true,
            health: true,
        };
        const state = await fixture(() => Promise.resolve(observation));
        try {
            const plan = await state.refresh();
            const clock = spyOn(Date, "now").mockReturnValue(Date.now() + offset);
            let accepted: { id: string };
            try {
                accepted = await state.caller.maintenance.request({
                    target: "web",
                    revision: plan.revision,
                    requestId: Bun.randomUUIDv7(),
                });
            } finally {
                clock.mockRestore();
            }
            await state.execute("maintenance.restart.web");
            const detail = await state.caller.jobs.detail({ id: accepted.id });
            expect(detail.run.state).toBe("succeeded");
            const next = await state.refresh();
            const expired = await state.caller.maintenance.request({
                target: "web",
                revision: next.revision,
                requestId: Bun.randomUUIDv7(),
            });
            await state.client`UPDATE job_runs SET created_at = now() - interval '6 minutes' WHERE id = ${expired.id}`;
            const workerClock = spyOn(Date, "now").mockReturnValue(
                Date.now() - 86_400_000
            );
            try {
                await expectOperationFailure(
                    state.execute("maintenance.restart.web"),
                    "expired"
                );
            } finally {
                workerClock.mockRestore();
            }
        } finally {
            await state.close();
        }
    }
);

test.each([false, true])(
    "restart receipts preserve unknown source requirements when multiple hosts share a source: %s",
    async (differentHost) => {
        const observation: MaintenanceObservation = {
            bootId: Bun.randomUUIDv7(),
            active: "active",
            invocationId: "a".repeat(32),
            rebootRequired: false,
            serviceRestartRequired: false,
            health: true,
        };
        const second = {
            ...connections[0]!,
            id: "other",
            host: differentHost
                ? "other.example.test"
                : connections[0]!.host.toUpperCase(),
        };
        const state = await fixture(() => Promise.resolve(observation), target, [
            ...connections,
            second,
        ]);
        try {
            const plan = await state.refresh();
            const queued = await state.caller.maintenance.request({
                target: "web",
                revision: plan.revision,
                requestId: Bun.randomUUIDv7(),
            });
            await state.execute("maintenance.restart.web");
            const [source] = await state.client<
                { value: { required: boolean | null } }[]
            >`SELECT value FROM operation_snapshots WHERE key = 'updates.restart:demo'`;
            expect(source?.value.required).toBe(differentHost ? null : false);
            const detail = await state.caller.jobs.detail({ id: queued.id });
            expect(detail.run.results[0]?.rebootRequired).toBe(false);
        } finally {
            await state.close();
        }
    }
);
