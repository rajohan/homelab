import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { setMiraEnabled } from "@homelab/mira/data/automations";
import {
    claimMiraBrowserAccess,
    closeMiraBrowserAccess,
} from "@homelab/mira/data/browserAccess";
import {
    advanceMiraBrowserProcess,
    beginMiraBrowserProcessCleanup,
    claimMiraBrowserProcessRecovery,
    confirmMiraBrowserProcessCleanup,
    renewMiraBrowserProcess,
    recordMiraBrowserProcessCleanup,
    reserveMiraBrowserProcess,
} from "@homelab/mira/data/browserProcesses";
import { claimMiraRun } from "@homelab/mira/data/queue";

import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

const imageId = `sha256:${"a".repeat(64)}`,
    containerId = "b".repeat(64);
async function fixture() {
    const f = await operationFixture(),
        hostId = crypto.randomUUID();
    const grant = async (owner: string) => {
        const context = { client: f.client, owner, actor: `human:${owner}` };
        const api = appRouter.createCaller({
            operations: f,
            principal: { kind: "human", id: owner, capabilities },
            verifyHuman: () =>
                Promise.resolve({ kind: "human" as const, id: owner, capabilities }),
        }).mira;
        await setMiraEnabled(context, {
            key: "computer:browser",
            version: 1,
            enabled: true,
            reason: null,
            until: null,
        });
        const chat = await api.conversations.create({
            title: "Synthetic process registry",
        });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Synthetic browser task",
            attachmentIds: [],
        });
        const run =
            (await claimMiraRun(f.client, crypto.randomUUID(), "foreground")) ??
            (await claimMiraRun(f.client, crypto.randomUUID(), "general"));
        if (!run || run.owner !== owner) throw new Error("Expected owned fixture run.");
        const worker = {
            ...context,
            actor: `mira:${run.id}`,
            run: { id: run.id, leaseToken: run.leaseToken },
        };
        const requested = await api.browser.request({
            runId: run.id,
            origins: ["https://example.test"],
            initialUrl: "https://example.test/",
            mode: "control",
        });
        const access = await claimMiraBrowserAccess(worker, requested.id);
        const input = {
            accessId: access.id,
            hostToken: access.hostToken,
            hostId,
            imageId,
        };
        return { api, worker, run, access, input };
    };
    return { ...f, hostId, grant };
}

test("durable reservations enforce two global slots including unfinished old cleanup", async () => {
    const f = await fixture();
    try {
        const original = await f.grant("first"),
            record = await reserveMiraBrowserProcess(f.client, original.input);
        // The completed job must not free its unconfirmed browser process slot.
        await f.client`UPDATE mira_runs SET state='completed',finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=${original.run.id}`;
        const grants = [await f.grant("second"), await f.grant("third")];
        grants[0]!.input.hostId = crypto.randomUUID();
        grants[1]!.input.hostId = crypto.randomUUID();
        const outcomes = await Promise.allSettled(
            grants.map((g) => reserveMiraBrowserProcess(f.client, g.input))
        );
        const reserved = outcomes.filter((x) => x.status === "fulfilled");
        expect(reserved).toHaveLength(1);
        expect(outcomes.filter((x) => x.status === "rejected")).toHaveLength(1);
        expect(record.containerName).toBe(`mira-browser-${record.id}`);
        expect(record.phase).toBe("reserved");
        const current = grants.find((g) => g.access.id === reserved[0]!.value.accessId)!;
        await rejects(
            reserveMiraBrowserProcess(f.client, current.input),
            /capacity is reserved/
        );
        await rejects(
            closeMiraBrowserAccess(original.worker, {
                id: original.access.id,
                hostToken: original.access.hostToken,
            }),
            /cleanup must be confirmed/
        );
        const stopped = await beginMiraBrowserProcessCleanup(f.client, record.claim);
        await confirmMiraBrowserProcessCleanup(f.client, stopped.claim, {
            kind: "not-created",
        });
        const remaining = grants.find(
            (g) => !reserved.some((x) => x.value.accessId === g.access.id)
        )!;
        const next = await reserveMiraBrowserProcess(f.client, remaining.input);
        expect(next.state).toBe("active");
        expect(await original.api.browser.list()).toMatchObject([{ state: "closed" }]);
    } finally {
        await f.close();
    }
});

test("private claims reject mismatched host, grant token and mutable container phases", async () => {
    const f = await fixture();
    try {
        const g = await f.grant("operator");
        for (const invalid of [
            { hostToken: crypto.randomUUID() },
            { hostId: "public" },
            { imageId: "image:latest" },
            { imageId: "sha256:invalid" },
        ])
            await rejects(
                reserveMiraBrowserProcess(f.client, { ...g.input, ...invalid })
            );
        const p = await reserveMiraBrowserProcess(f.client, g.input);
        await rejects(
            renewMiraBrowserProcess(f.client, { ...p.claim, hostId: crypto.randomUUID() })
        );
        await rejects(
            renewMiraBrowserProcess(f.client, {
                ...p.claim,
                leaseToken: crypto.randomUUID(),
            })
        );
        await rejects(
            advanceMiraBrowserProcess(f.client, p.claim, {
                phase: "created",
                containerId,
            })
        );
        await advanceMiraBrowserProcess(f.client, p.claim, { phase: "creating" });
        await rejects(
            advanceMiraBrowserProcess(f.client, p.claim, { phase: "creating" })
        );
        await rejects(
            advanceMiraBrowserProcess(f.client, p.claim, {
                phase: "created",
                containerId: "invalid",
            })
        );
        const created = await advanceMiraBrowserProcess(f.client, p.claim, {
            phase: "created",
            containerId,
        });
        expect(created.containerId).toBe(containerId);
        await rejects(
            advanceMiraBrowserProcess(f.client, p.claim, {
                phase: "created",
                containerId: "c".repeat(64),
            })
        );
        expect(JSON.stringify(await g.api.browser.list())).not.toContain(
            p.claim.leaseToken
        );
    } finally {
        await f.close();
    }
});

test("expired creator leases cannot renew and recovery is host-bound and single-winner", async () => {
    const f = await fixture();
    try {
        const g = await f.grant("operator"),
            p = await reserveMiraBrowserProcess(f.client, g.input);
        expect(await claimMiraBrowserProcessRecovery(f.client, f.hostId)).toBeNull();
        await f.client`UPDATE mira_browser_processes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${p.id}`;
        await rejects(renewMiraBrowserProcess(f.client, p.claim));
        await rejects(
            advanceMiraBrowserProcess(f.client, p.claim, { phase: "creating" })
        );
        expect(
            await claimMiraBrowserProcessRecovery(f.client, crypto.randomUUID())
        ).toBeNull();
        const choices = await Promise.all([
            claimMiraBrowserProcessRecovery(f.client, f.hostId),
            claimMiraBrowserProcessRecovery(f.client, f.hostId),
        ]);
        const recovered = choices.find((x) => x !== null)!;
        expect(choices.filter((x) => x !== null)).toHaveLength(1);
        expect(recovered.claim.leaseToken).not.toBe(p.claim.leaseToken);
        expect(recovered.state).toBe("cleanup");
        for (const action of [
            () => renewMiraBrowserProcess(f.client, p.claim),
            () => beginMiraBrowserProcessCleanup(f.client, p.claim),
            () =>
                confirmMiraBrowserProcessCleanup(f.client, p.claim, {
                    kind: "not-created",
                }),
        ])
            await rejects(action());
        expect(await g.api.browser.list()).toMatchObject([
            { state: "stopping", origins: [], initialUrl: null },
        ]);
        await confirmMiraBrowserProcessCleanup(f.client, recovered.claim, {
            kind: "not-created",
        });
        expect(await g.api.browser.list()).toMatchObject([{ state: "closed" }]);
    } finally {
        await f.close();
    }
});

test("unknown creation plus absence cannot free capacity or close the grant", async () => {
    const f = await fixture();
    try {
        const g = await f.grant("operator"),
            p = await reserveMiraBrowserProcess(f.client, g.input);
        await advanceMiraBrowserProcess(f.client, p.claim, { phase: "creating" });
        await beginMiraBrowserProcessCleanup(f.client, p.claim);
        await rejects(
            confirmMiraBrowserProcessCleanup(f.client, p.claim, { kind: "not-created" })
        );
        await rejects(
            confirmMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "absent",
                containerId,
            })
        );
        expect(await g.api.browser.list()).toMatchObject([{ state: "stopping" }]);
        await rejects(
            closeMiraBrowserAccess(g.worker, {
                id: g.access.id,
                hostToken: g.access.hostToken,
            }),
            /cleanup must be confirmed/
        );
        await rejects(
            confirmMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "removed",
                containerId,
            })
        );
        await recordMiraBrowserProcessCleanup(f.client, p.claim, {
            kind: "discovered",
            containerId,
        });
        await confirmMiraBrowserProcessCleanup(f.client, p.claim, {
            kind: "removed",
            containerId,
        });
        await confirmMiraBrowserProcessCleanup(f.client, p.claim, {
            kind: "removed",
            containerId,
        });
        expect(await g.api.browser.list()).toMatchObject([{ state: "closed" }]);
        const audits = await f.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_audit WHERE action='browser.access_closed'`;
        expect(audits[0]!.count).toBe(1);
    } finally {
        await f.close();
    }
});

test("known container cleanup must match its immutable ID and a current cleanup lease", async () => {
    const f = await fixture();
    try {
        const g = await f.grant("operator"),
            p = await reserveMiraBrowserProcess(f.client, g.input);
        await advanceMiraBrowserProcess(f.client, p.claim, { phase: "creating" });
        await advanceMiraBrowserProcess(f.client, p.claim, {
            phase: "created",
            containerId,
        });
        await rejects(
            confirmMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "absent",
                containerId,
            })
        );
        await beginMiraBrowserProcessCleanup(f.client, p.claim);
        await rejects(
            confirmMiraBrowserProcessCleanup(f.client, p.claim, { kind: "not-created" })
        );
        await rejects(
            confirmMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "removed",
                containerId: "c".repeat(64),
            })
        );
        await f.client`UPDATE mira_browser_processes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${p.id}`;
        await rejects(
            confirmMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "absent",
                containerId,
            })
        );
        const fresh = await beginMiraBrowserProcessCleanup(f.client, p.claim);
        await rejects(renewMiraBrowserProcess(f.client, fresh.claim));
        await confirmMiraBrowserProcessCleanup(f.client, fresh.claim, {
            kind: "absent",
            containerId,
        });
        expect(await g.api.browser.list()).toMatchObject([{ state: "closed" }]);
    } finally {
        await f.close();
    }
});

test("revoked browser grants and dead jobs deny creation but allow original cleanup", async () => {
    for (const reason of ["stop", "lease"]) {
        const f = await fixture();
        try {
            const g = await f.grant("operator"),
                p = await reserveMiraBrowserProcess(f.client, g.input);
            await (reason === "stop"
                ? g.api.browser.stop({ id: g.access.id })
                : f.client`UPDATE mira_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${g.run.id}`);
            await rejects(
                advanceMiraBrowserProcess(f.client, p.claim, { phase: "creating" })
            );
            await rejects(renewMiraBrowserProcess(f.client, p.claim));
            await beginMiraBrowserProcessCleanup(f.client, p.claim);
            await confirmMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "not-created",
            });
            expect(await g.api.browser.list()).toMatchObject([{ state: "closed" }]);
        } finally {
            await f.close();
        }
    }
});

test.each(["expiry", "replacement"])(
    "controller authority is rechecked after the owner lock (%s)",
    async (change) => {
        const f = await fixture(),
            entered = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
        let blocking: Promise<unknown> | undefined;
        try {
            const g = await f.grant("operator"),
                p = await reserveMiraBrowserProcess(f.client, g.input);
            blocking = f.client.begin(async (query) => {
                await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:controls:operator',0))`;
                entered.resolve();
                await release.promise;
                await (change === "expiry"
                    ? query`UPDATE mira_browser_processes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${p.id}`
                    : query`UPDATE mira_browser_processes SET lease_token=${crypto.randomUUID()} WHERE id=${p.id}`);
            });
            await entered.promise;
            const pending = rejects(renewMiraBrowserProcess(f.client, p.claim));
            const deadline = performance.now() + 1000;
            let waiting = false;
            while (performance.now() < deadline) {
                const rows = await f.client<
                    { waiting: boolean }[]
                >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`;
                if (rows[0]!.waiting) {
                    waiting = true;
                    break;
                }
                await Bun.sleep(5);
            }
            expect(waiting).toBe(true);
            release.resolve();
            await blocking;
            await pending;
        } finally {
            release.resolve();
            await blocking;
            await f.close();
        }
    }
);

test("database constraints reject incomplete created and removed records", async () => {
    const f = await fixture();
    try {
        const g = await f.grant("operator"),
            p = await reserveMiraBrowserProcess(f.client, g.input);
        await rejects(
            f.client`UPDATE mira_browser_processes SET phase='created',container_id=NULL WHERE id=${p.id}`
        );
        await rejects(
            f.client`UPDATE mira_browser_processes SET state='removed',removed_at=clock_timestamp(),cleanup_evidence=NULL WHERE id=${p.id}`
        );
        await rejects(
            f.client`UPDATE mira_browser_processes SET state='removed',removed_at=clock_timestamp(),cleanup_evidence='absent' WHERE id=${p.id}`
        );
    } finally {
        await f.close();
    }
});

test("a blocked owner heartbeat does not block a different owner", async () => {
    const f = await fixture(),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
    let blocking: Promise<unknown> | undefined,
        first: Promise<unknown> | undefined,
        second: Promise<unknown> | undefined;
    try {
        const a = await f.grant("first"),
            b = await f.grant("second"),
            pa = await reserveMiraBrowserProcess(f.client, a.input),
            pb = await reserveMiraBrowserProcess(f.client, b.input);
        blocking = f.client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:controls:first',0))`;
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        first = renewMiraBrowserProcess(f.client, pa.claim);
        const deadline = performance.now() + 1000;
        let waiting = false;
        while (performance.now() < deadline) {
            const rows = await f.client<
                { waiting: boolean }[]
            >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`;
            if (rows[0]!.waiting) {
                waiting = true;
                break;
            }
            await Bun.sleep(5);
        }
        expect(waiting).toBe(true);
        second = renewMiraBrowserProcess(f.client, pb.claim);
        expect(
            await Promise.race([
                second.then(() => true),
                Bun.sleep(1000).then(() => false),
            ])
        ).toBe(true);
    } finally {
        release.resolve();
        await blocking;
        await first;
        await second;
        await f.close();
    }
});

test("cleanup discovery and settled rejection require the current controller and persist before final proof", async () => {
    const f = await fixture();
    try {
        const g = await f.grant("operator"),
            p = await reserveMiraBrowserProcess(f.client, g.input);
        await advanceMiraBrowserProcess(f.client, p.claim, { phase: "creating" });
        await rejects(
            recordMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "rejected",
                status: 404,
            })
        );
        await beginMiraBrowserProcessCleanup(f.client, p.claim);
        await rejects(
            recordMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "rejected",
                status: 503,
            })
        );
        expect(
            await recordMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "rejected",
                status: 404,
            })
        ).toMatchObject({ phase: "rejected", containerId: null });
        await rejects(
            confirmMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "absent",
                containerId,
            })
        );
        await f.client`UPDATE mira_browser_processes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${p.id}`;
        await rejects(
            recordMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "discovered",
                containerId,
            })
        );
        const recovered = await claimMiraBrowserProcessRecovery(f.client, f.hostId);
        expect(recovered?.phase).toBe("rejected");
        await rejects(
            recordMiraBrowserProcessCleanup(f.client, p.claim, {
                kind: "discovered",
                containerId,
            })
        );
        await recordMiraBrowserProcessCleanup(f.client, recovered!.claim, {
            kind: "discovered",
            containerId,
        });
        await rejects(
            recordMiraBrowserProcessCleanup(f.client, recovered!.claim, {
                kind: "discovered",
                containerId: "c".repeat(64),
            })
        );
        await rejects(
            recordMiraBrowserProcessCleanup(f.client, recovered!.claim, {
                kind: "rejected",
                status: 400,
            })
        );
        await confirmMiraBrowserProcessCleanup(f.client, recovered!.claim, {
            kind: "absent",
            containerId,
        });
        expect(await g.api.browser.list()).toMatchObject([{ state: "closed" }]);
    } finally {
        await f.close();
    }
});

test("private browser networks stay reserved through cleanup and are allocated independently", async () => {
    const f = await fixture();
    try {
        const networkIds = ["c".repeat(64), "d".repeat(64)];
        const a = await f.grant("network-first"),
            b = await f.grant("network-second");
        const [first, second] = await Promise.all([
            reserveMiraBrowserProcess(f.client, { ...a.input, networkIds }),
            reserveMiraBrowserProcess(f.client, { ...b.input, networkIds }),
        ]);
        expect(new Set([first.networkId!, second.networkId!])).toEqual(
            new Set(networkIds)
        );
        await beginMiraBrowserProcessCleanup(f.client, first.claim);
        const [persisted] = await f.client<
            { networkId: string }[]
        >`SELECT network_id AS "networkId" FROM mira_browser_processes WHERE id=${first.id}`;
        expect(persisted!.networkId).toBe(first.networkId!);
        await confirmMiraBrowserProcessCleanup(f.client, first.claim, {
            kind: "not-created",
        });
        await f.client`UPDATE mira_runs SET state='completed',finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=${a.run.id}`;
        const third = await f.grant("network-third");
        await rejects(
            reserveMiraBrowserProcess(f.client, {
                ...third.input,
                networkIds: [second.networkId],
            }),
            /networks are reserved/
        );
        const replacement = await reserveMiraBrowserProcess(f.client, {
            ...third.input,
            networkIds,
        });
        expect(replacement.networkId).toBe(first.networkId);
    } finally {
        await f.close();
    }
});
