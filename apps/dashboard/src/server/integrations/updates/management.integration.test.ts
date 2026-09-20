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
import { parseUpdateTargets, updateTargetRevision } from "./configuration";
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

async function fixture() {
    const state = await operationFixture();
    const calls: { item: UpdateItem; automatic: boolean }[] = [];
    const handlers = updateActionJobs(
        [target],
        state.client,
        async (_target, software, automatic, _signal, report) => {
            calls.push({ item: software, automatic });
            await report("Verifying the synthetic update.");
            return {
                installed: software.available!,
                rebootRequired: true,
                containerId: "f".repeat(64),
            };
        }
    );
    const operations = {
        ...state,
        registry: createJobRegistry(handlers),
        updateTargets: [target],
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
        repositoryMetadataAt: null,
        complete: true,
        coveredKinds: ["container"],
        items: [item],
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
        expect(notification?.title).toContain("restart required");
        expect(await state.caller.updates.request(input)).toEqual(first);
        await expectOperationFailure(
            state.caller.updates.request({ ...input, item: "different" }),
            "different job"
        );
    } finally {
        await state.close();
    }
});

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
                        inspect: ["/bin/demo", "--version"],
                        install: ["/bin/demo", "upgrade"],
                        health: ["/bin/demo", "health"],
                    },
                },
            ])
        )
    ).toThrow("exact approved version");
});
