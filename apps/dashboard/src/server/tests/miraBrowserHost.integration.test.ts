import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import {
    openMiraBrowserSession,
    recoverMiraBrowserProcesses,
} from "@homelab/mira/data/browserHost";
import { saveMiraBrowserProfileSnapshot } from "@homelab/mira/data/browserProcesses";

import { browserHostFixture as fixture } from "../testing/miraBrowserHost";

function runtime() {
    const controller = new AbortController(),
        calls: string[] = [];
    let fail = false;
    const open = () =>
        Promise.resolve({
            signal: controller.signal,
            observe: (): Promise<never> =>
                Promise.reject(new Error("No image fixture is needed.")),
            navigate: (url: unknown) => {
                calls.push("navigate");
                return Promise.resolve({ url: String(url) });
            },
            act: () => {
                calls.push("act");
                return Promise.resolve({ effect: "unverified" as const });
            },
            close: () => {
                calls.push("close");
                controller.abort();
                return fail
                    ? Promise.reject(new Error("Synthetic cleanup failure"))
                    : Promise.resolve();
            },
        });
    return {
        open,
        calls,
        fail: () => {
            fail = true;
        },
    };
}

test("supervised host consumes a grant once, snapshots its owner and releases after human stop", async () => {
    const f = await fixture(),
        native = runtime(),
        owner = new AbortController();
    try {
        const grant = await f.api.browser.request(f.request);
        const original = { ...f.worker, run: { ...f.worker.run } };
        const opening = openMiraBrowserSession(
            original,
            grant.id,
            f.config,
            owner.signal,
            { open: native.open }
        );
        original.owner = "other";
        original.run.leaseToken = crypto.randomUUID();
        const session = await opening;
        await rejects(
            openMiraBrowserSession(f.worker, grant.id, f.config, owner.signal, {
                open: native.open,
            })
        );
        await session.navigate(f.request.initialUrl, owner.signal);
        await f.api.browser.stop({ id: grant.id });
        await rejects(
            session.navigate(f.request.initialUrl, owner.signal),
            /Browser access stopped/
        );
        await session.closed;
        expect(native.calls).toEqual(["navigate", "close"]);
        expect(await f.api.browser.list()).toMatchObject([
            { id: grant.id, state: "closed", initialUrl: null, origins: [] },
        ]);
        const rows = await f.client<
            { action: string }[]
        >`SELECT action FROM mira_audit WHERE action='browser.access_closed'`;
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(session)).not.toContain(f.run.leaseToken);
    } finally {
        owner.abort();
        await f.close();
    }
});

test("view-only database authority denies native input and retires its session", async () => {
    const f = await fixture(),
        native = runtime(),
        owner = new AbortController();
    try {
        const grant = await f.api.browser.request({ ...f.request, mode: "view" });
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            owner.signal,
            { open: native.open }
        );
        await rejects(
            session.act({ action: "click" }, owner.signal),
            /Browser access stopped/
        );
        expect(native.calls).toEqual(["close"]);
        expect(await f.api.browser.list()).toMatchObject([{ state: "closed" }]);
    } finally {
        owner.abort();
        await f.close();
    }
});

test("unconfirmed native startup and cleanup keep the durable slot reserved", async () => {
    for (const failure of ["startup", "cleanup"]) {
        const f = await fixture(),
            native = runtime(),
            owner = new AbortController();
        try {
            const grant = await f.api.browser.request(f.request);
            if (failure === "startup") {
                await rejects(
                    openMiraBrowserSession(f.worker, grant.id, f.config, owner.signal, {
                        open: () =>
                            Promise.reject(new Error("Synthetic startup failure")),
                    }),
                    /cleanup could not be confirmed/
                );
            } else {
                const session = await openMiraBrowserSession(
                    f.worker,
                    grant.id,
                    f.config,
                    owner.signal,
                    { open: native.open }
                );
                native.fail();
                await rejects(session.close(), /cleanup could not be confirmed/);
            }
            await f.api.browser.stop({ id: grant.id });
            expect(await f.api.browser.list()).toMatchObject([{ state: "stopping" }]);
            await rejects(f.api.browser.request(f.request), /finish browser cleanup/);
        } finally {
            owner.abort();
            await f.close();
        }
    }
});

test("idle host detects a revoked run and closes without another browser command", async () => {
    const f = await fixture(),
        native = runtime(),
        owner = new AbortController();
    try {
        const grant = await f.api.browser.request(f.request);
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            owner.signal,
            { open: native.open }
        );
        await f.client`UPDATE mira_runs SET cancel_requested=true WHERE id=${f.run.id}`;
        await session.closed;
        expect(native.calls).toEqual(["close"]);
        expect(await f.api.browser.list()).toMatchObject([{ state: "closed" }]);
    } finally {
        owner.abort();
        await f.close();
    }
});

test("real host transport journals creation and startup then closes the registry only after Docker removal", async () => {
    const f = await fixture(),
        owner = new AbortController();
    try {
        const grant = await f.api.browser.request(f.request);
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            owner.signal
        );
        const [record] = await f.client<
            { id: string; state: string; phase: string; containerId: string }[]
        >`SELECT id,state,phase,container_id AS "containerId" FROM mira_browser_processes`;
        expect(record).toMatchObject({
            id: f.engine.label,
            phase: "created",
            state: "active",
            containerId: f.engine.id,
        });
        await session.navigate(f.request.initialUrl, owner.signal);
        await f.api.browser.stop({ id: grant.id });
        await session.closed;
        expect(f.engine.exists).toBe(false);
        expect(
            await f.client`SELECT state,cleanup_evidence FROM mira_browser_processes`
        ).toEqual([{ state: "removed", cleanup_evidence: "removed" }]);
        expect(await f.api.browser.list()).toMatchObject([{ state: "closed" }]);
        expect(f.engine.events.filter((e) => e.endsWith("/start"))).toHaveLength(1);
        expect(f.engine.events.filter((e) => e === "navigate")).toHaveLength(1);
    } finally {
        owner.abort();
        await f.close();
    }
});

test("failed native removal retains capacity until host recovery verifies the original image and ID", async () => {
    const f = await fixture(),
        owner = new AbortController();
    try {
        const grant = await f.api.browser.request(f.request);
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            owner.signal
        );
        f.engine.failDelete = true;
        await rejects(session.close(), /cleanup could not be confirmed/);
        expect(f.engine.exists).toBe(true);
        await rejects(f.api.browser.request(f.request), /finish browser cleanup/);
        await f.client`UPDATE mira_browser_processes SET lease_expires_at=clock_timestamp()-interval '1 second'`;
        expect(
            await recoverMiraBrowserProcesses(f.client, {
                ...f.config,
                hostId: crypto.randomUUID(),
            })
        ).toEqual({ recovered: 0, unresolved: 0 });
        f.engine.failDelete = false;
        // An updater may now select a different image; old cleanup uses its recorded image.
        expect(
            await recoverMiraBrowserProcesses(f.client, {
                ...f.config,
                imageId: `sha256:${"c".repeat(64)}`,
            })
        ).toEqual({ recovered: 1, unresolved: 0 });
        expect(f.engine.exists).toBe(false);
        expect(await f.api.browser.list()).toMatchObject([{ state: "closed" }]);
        expect(f.engine.events.filter((e) => e.endsWith("/start"))).toHaveLength(1);
        await rejects(session.navigate(f.request.initialUrl, owner.signal));
    } finally {
        owner.abort();
        await f.close();
    }
});

test("unknown creation plus absence retains its slot until the late owned container is actually removed", async () => {
    const f = await fixture(),
        owner = new AbortController();
    try {
        const grant = await f.api.browser.request(f.request);
        f.engine.failCreate = true;
        await rejects(
            openMiraBrowserSession(f.worker, grant.id, f.config, owner.signal),
            /cleanup could not be confirmed/
        );
        expect(await f.client`SELECT phase,state FROM mira_browser_processes`).toEqual([
            { phase: "creating", state: "cleanup" },
        ]);
        await f.client`UPDATE mira_browser_processes SET lease_expires_at=clock_timestamp()-interval '1 second'`;
        expect(await recoverMiraBrowserProcesses(f.client, f.config)).toEqual({
            recovered: 0,
            unresolved: 1,
        });
        expect(await recoverMiraBrowserProcesses(f.client, f.config)).toEqual({
            recovered: 0,
            unresolved: 0,
        });
        await rejects(f.api.browser.request(f.request), /finish browser cleanup/);
        f.engine.exists = true;
        await f.client`UPDATE mira_browser_processes SET lease_expires_at=clock_timestamp()-interval '1 second'`;
        expect(await recoverMiraBrowserProcesses(f.client, f.config)).toEqual({
            recovered: 1,
            unresolved: 0,
        });
        expect(f.engine.exists).toBe(false);
        expect(f.engine.events.filter((e) => e.endsWith("/start"))).toHaveLength(0);
        expect(
            f.engine.events.filter((e) => e.startsWith("POST:/containers/create"))
        ).toHaveLength(1);
    } finally {
        owner.abort();
        await f.close();
    }
});

test("an expired replaced controller cannot operate or close a recovered lifetime again", async () => {
    const f = await fixture(),
        owner = new AbortController();
    try {
        const grant = await f.api.browser.request(f.request);
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            owner.signal
        );
        await f.client`UPDATE mira_browser_processes SET lease_expires_at=clock_timestamp()-interval '1 second'`;
        expect(await recoverMiraBrowserProcesses(f.client, f.config)).toEqual({
            recovered: 1,
            unresolved: 0,
        });
        await rejects(session.closed, /cleanup could not be confirmed/);
        await rejects(session.navigate(f.request.initialUrl, owner.signal));
        expect(f.engine.events.filter((e) => e === "navigate")).toHaveLength(0);
        expect(await f.api.browser.list()).toMatchObject([{ state: "closed" }]);
        expect(await f.client`SELECT state FROM mira_browser_processes`).toEqual([
            { state: "removed" },
        ]);
    } finally {
        owner.abort();
        await f.close();
    }
});

test("settled Docker create rejection closes durable capacity without disabling later sessions", async () => {
    const f = await fixture(),
        owner = new AbortController();
    try {
        for (const status of [400, 404, 409]) {
            const grant = await f.api.browser.request(f.request);
            f.engine.rejectCreate = status;
            await rejects(
                openMiraBrowserSession(f.worker, grant.id, f.config, owner.signal)
            );
            expect(
                await f.client`SELECT state,phase,cleanup_evidence FROM mira_browser_processes WHERE access_id=${grant.id}`
            ).toEqual([
                { state: "removed", phase: "rejected", cleanup_evidence: "rejected" },
            ]);
        }
        f.engine.rejectCreate = null;
        const grant = await f.api.browser.request(f.request);
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            owner.signal
        );
        await session.close();
        expect(f.engine.exists).toBe(false);
    } finally {
        owner.abort();
        await f.close();
    }
});

test("an ID discovered during unknown-create recovery survives a failure after actual deletion", async () => {
    const f = await fixture(),
        owner = new AbortController();
    try {
        const grant = await f.api.browser.request(f.request);
        f.engine.failCreate = true;
        await rejects(openMiraBrowserSession(f.worker, grant.id, f.config, owner.signal));
        f.engine.exists = true;
        f.engine.replaceCleanupAfterDelete = true;
        await f.client`UPDATE mira_browser_processes SET lease_expires_at=clock_timestamp()-interval '1 second'`;
        expect(await recoverMiraBrowserProcesses(f.client, f.config)).toEqual({
            recovered: 0,
            unresolved: 1,
        });
        expect(f.engine.exists).toBe(false);
        expect(
            await f.client`SELECT phase,state,container_id FROM mira_browser_processes`
        ).toEqual([{ phase: "created", state: "cleanup", container_id: f.engine.id }]);
        await f.client`UPDATE mira_browser_processes SET lease_expires_at=clock_timestamp()-interval '1 second'`;
        expect(await recoverMiraBrowserProcesses(f.client, f.config)).toEqual({
            recovered: 1,
            unresolved: 0,
        });
        expect(await f.api.browser.list()).toMatchObject([{ state: "closed" }]);
        expect(f.engine.events.filter((e) => e.startsWith("DELETE:"))).toHaveLength(1);
    } finally {
        owner.abort();
        await f.close();
    }
});

test("saved snapshots are private, reused after cleanup, and erased with their reserved slot", async () => {
    const f = await fixture(),
        owner = new AbortController();
    try {
        const profile = await f.api.browser.createProfile({
            name: "Private synthetic profile",
            origins: f.request.origins,
        });
        const grant = await f.api.browser.request({
            ...f.request,
            profileId: profile.id,
        });
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            owner.signal
        );
        expect(f.engine.restored).toEqual([null]);
        await rejects(f.api.browser.deleteProfile(profile), /cleanup/);
        await session.close();
        const [row] = await f.client<
            { snapshot: string; host: string }[]
        >`SELECT snapshot,host_id AS host FROM mira_browser_profiles WHERE id=${profile.id}`;
        expect(row).toEqual({ snapshot: f.engine.snapshot, host: f.config.hostId });
        expect(JSON.stringify(await f.api.browser.profiles())).not.toContain(
            f.engine.snapshot
        );
        f.engine.id = "c".repeat(64);
        const second = await f.api.browser.request({
            ...f.request,
            profileId: profile.id,
        });
        const reopened = await openMiraBrowserSession(
            f.worker,
            second.id,
            f.config,
            owner.signal
        );
        expect(f.engine.restored).toEqual([null, f.engine.snapshot]);
        await reopened.close();
        expect(f.engine.events.some((item) => item.includes("/volumes"))).toBe(false);
        await f.api.browser.deleteProfile(profile);
        expect(await f.api.browser.profiles()).toEqual([]);
        const [deleted] = await f.client<
            { snapshot: null; slot: null }[]
        >`SELECT snapshot,quota_slot AS slot FROM mira_browser_profiles WHERE id=${profile.id}`;
        expect(deleted).toEqual({ snapshot: null, slot: null });
    } finally {
        owner.abort();
        await f.close();
    }
});

test("missing checkpoints retain the prior snapshot and stale process leases cannot overwrite it", async () => {
    const f = await fixture(),
        owner = new AbortController();
    try {
        const profile = await f.api.browser.createProfile({
            name: "Interrupted profile",
            origins: f.request.origins,
        });
        await f.client`UPDATE mira_browser_profiles SET host_id=${f.config.hostId},snapshot=${f.engine.snapshot} WHERE id=${profile.id}`;
        const grant = await f.api.browser.request({
            ...f.request,
            profileId: profile.id,
        });
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            owner.signal
        );
        const [claim] = await f.client<
            { id: string; hostId: string; leaseToken: string }[]
        >`SELECT id,host_id AS "hostId",lease_token AS "leaseToken" FROM mira_browser_processes WHERE access_id=${grant.id}`;
        await rejects(
            saveMiraBrowserProfileSnapshot(
                f.client,
                { ...claim, leaseToken: crypto.randomUUID() },
                f.engine.snapshot
            )
        );
        f.engine.omitCheckpoint = true;
        await session.close();
        await rejects(saveMiraBrowserProfileSnapshot(f.client, claim, f.engine.snapshot));
        const [row] = await f.client<
            { snapshot: string }[]
        >`SELECT snapshot FROM mira_browser_profiles WHERE id=${profile.id}`;
        expect(row?.snapshot).toBe(f.engine.snapshot);
    } finally {
        owner.abort();
        await f.close();
    }
});
