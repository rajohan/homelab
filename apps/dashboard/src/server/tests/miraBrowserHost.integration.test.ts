import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import { capabilities } from "@homelab/contracts/operations";
import { setMiraEnabled } from "@homelab/mira/data/automations";
import {
    openMiraBrowserSession,
    recoverMiraBrowserProcesses,
} from "@homelab/mira/data/browserHost";
import { claimMiraRun } from "@homelab/mira/data/queue";

import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

async function fixture(enabled = true) {
    const f = await operationFixture();
    const caller = (
        owner = "operator",
        verified = owner,
        kind: "human" | "automation" = "human",
        fresh = true
    ) =>
        appRouter.createCaller({
            operations: f,
            principal: { kind, id: owner, capabilities },
            ...(fresh
                ? {
                      verifyHuman: () =>
                          Promise.resolve({ kind, id: verified, capabilities }),
                  }
                : {}),
        }).mira;
    const api = caller();
    const context = { client: f.client, owner: "operator", actor: "human:operator" };
    if (enabled)
        await setMiraEnabled(context, {
            key: "computer:browser",
            version: 1,
            enabled: true,
            reason: null,
            until: null,
        });
    const chat = await api.conversations.create({ title: "Synthetic browser access" });
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Synthetic browser task",
        attachmentIds: [],
    });
    const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
    if (!run) throw new Error("Expected synthetic run.");
    const worker = {
        ...context,
        actor: `mira:${run.id}`,
        run: { id: run.id, leaseToken: run.leaseToken },
    };
    const request = {
        runId: run.id,
        origins: ["https://example.test"],
        initialUrl: "https://example.test/start",
        mode: "control" as const,
    };
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-host-db-"));
    const socketPath = path.join(directory, "docker.sock");
    const engine = {
        id: "b".repeat(64),
        label: "",
        image: `sha256:${"a".repeat(64)}`,
        exists: false,
        failCreate: false,
        rejectCreate: null as number | null,
        replaceCleanupAfterDelete: false,
        failDelete: false,
        events: [] as string[],
    };
    const streams = new Set<Duplex>();
    const server = createServer((request, response) => {
        void (async () => {
            const route = request.url!.replace(/^\/v1\.45/, "");
            const chunks: Buffer[] = [];
            for await (const chunk of request)
                chunks.push(Buffer.from(chunk as Uint8Array));
            engine.events.push(`${request.method}:${route}`);
            let status: number,
                body: unknown = null;
            if (route.startsWith("/containers/create")) {
                const spec = JSON.parse(Buffer.concat(chunks).toString()) as {
                    Image: string;
                    Labels: Record<string, string>;
                };
                engine.label = spec.Labels["io.homelab.mira.browser-owner"]!;
                engine.image = spec.Image;
                const [row] = await f.client<
                    { phase: string }[]
                >`SELECT phase FROM mira_browser_processes WHERE id=${engine.label}`;
                expect(row?.phase).toBe("creating");
                expect(route).toBe(
                    `/containers/create?name=mira-browser-${engine.label}`
                );
                engine.exists = !engine.failCreate && engine.rejectCreate === null;
                status = engine.rejectCreate ?? (engine.failCreate ? 503 : 201);
                body = { Id: engine.id };
            } else if (route.endsWith("/json")) {
                status = engine.exists ? 200 : 404;
                body = engine.exists
                    ? {
                          Id: engine.id,
                          Image: engine.image,
                          Config: {
                              Labels: { "io.homelab.mira.browser-owner": engine.label },
                          },
                      }
                    : null;
            } else if (route.endsWith("/start")) {
                const [row] = await f.client<
                    { phase: string; containerId: string }[]
                >`SELECT phase,container_id AS "containerId" FROM mira_browser_processes WHERE id=${engine.label}`;
                expect(row).toEqual({ phase: "created", containerId: engine.id });
                status = 204;
            } else if (request.method === "DELETE") {
                const [row] = await f.client<
                    { state: string }[]
                >`SELECT state FROM mira_browser_processes WHERE id=${engine.label}`;
                expect(row?.state).toBe("cleanup");
                status = engine.failDelete ? 503 : 204;
                if (!engine.failDelete) {
                    engine.exists = false;
                    if (engine.replaceCleanupAfterDelete) {
                        await f.client`UPDATE mira_browser_processes SET lease_token=${crypto.randomUUID()},lease_expires_at=clock_timestamp()+interval '15 seconds' WHERE id=${engine.label}`;
                    }
                    for (const stream of streams) stream.destroy();
                }
            } else throw new Error("Unexpected fixture Docker request.");
            response.writeHead(status, { "content-type": "application/json" });
            response.end(status === 204 ? undefined : JSON.stringify(body));
        })().catch(() => {
            response.writeHead(500);
            response.end();
        });
    });
    server.on("upgrade", (_request, stream) => {
        streams.add(stream);
        stream.on("error", () => {});
        stream.on("close", () => streams.delete(stream));
        stream.write(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
        );
        let buffered = "";
        stream.on("data", (chunk: Buffer) => {
            buffered += chunk.toString();
            while (buffered.includes("\n")) {
                const end = buffered.indexOf("\n"),
                    line = buffered.slice(0, end);
                buffered = buffered.slice(end + 1);
                const message = JSON.parse(line) as {
                    id: number;
                    body: { method: string; params: { url?: string } };
                };
                engine.events.push(message.body.method);
                const result =
                    message.body.method === "initialize"
                        ? { version: 1, driver: "0.37.0" }
                        : { url: message.body.params.url };
                const bytes = Buffer.from(
                        JSON.stringify({ id: message.id, result }) + "\n"
                    ),
                    header = Buffer.alloc(8);
                header[0] = 1;
                header.writeUInt32BE(bytes.length, 4);
                stream.write(Buffer.concat([header, bytes]));
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const config = {
        hostId: crypto.randomUUID(),
        socketPath,
        imageId: `sha256:${"a".repeat(64)}`,
    };
    return {
        ...f,
        caller,
        api,
        context,
        worker,
        run,
        chat,
        request,
        config,
        engine,
        close: async () => {
            for (const stream of streams) stream.destroy();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            );
            await rm(directory, { recursive: true, force: true });
            await f.close();
        },
    };
}

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
