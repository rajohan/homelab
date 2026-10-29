import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { capabilities } from "@homelab/contracts/operations";
import {
    enqueueMiraComputerCommand,
    takeMiraComputerCommand,
} from "@homelab/mira/data/computerCommands";
import { claimMiraRun } from "@homelab/mira/data/queue";

import { ComputerCompanion } from "../../../../mira/src/server/computer/companion";
import type { ComputerConsentHost } from "../../../../mira/src/server/computer/companionConsent";
import { runComputerPresence } from "../../../../mira/src/server/computer/companionPresence";
import { computerConnectionWork } from "../../../../mira/src/server/computer/companionWork";
import type { ComputerWindowGrant } from "../../../../mira/src/server/computer/policy";
import { RuntimeCleanupError } from "../../../../mira/src/server/runtime/rpcProcess";
import { createVisualChallenge } from "../../../../mira/src/server/testing/visualChallenge";
import { appRouter } from "../api/router";
import { miraComputerReceiver } from "../mira/computerReceiver";
import { operationFixture } from "../testing/operations";

async function until(check: () => boolean | Promise<boolean>) {
    const deadline = performance.now() + 8000;
    while (!(await check())) {
        if (performance.now() >= deadline)
            throw new Error("Reconnect fixture timed out.");
        await delay(10);
    }
}

async function tlsFixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-reconnect-tls-"));
    try {
        const child = Bun.spawn(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-noenc",
                "-subj",
                "/CN=127.0.0.1",
                "-addext",
                "subjectAltName=IP:127.0.0.1",
                "-days",
                "1",
                "-keyout",
                path.join(directory, "key.pem"),
                "-out",
                path.join(directory, "cert.pem"),
            ],
            { stdout: "ignore", stderr: "ignore" }
        );
        const timeout = setTimeout(() => child.kill(), 10_000);
        try {
            if ((await child.exited) !== 0)
                throw new Error("Test certificate creation failed.");
        } finally {
            clearTimeout(timeout);
        }
        return {
            cert: await readFile(path.join(directory, "cert.pem")),
            key: await readFile(path.join(directory, "key.pem")),
        };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function fixture() {
    const tls = await tlsFixture();
    const f = await operationFixture();
    const stop = new AbortController();
    const events: string[] = [];
    const input: string[] = [];
    const prompts: { id: string; allow: () => void }[] = [];
    const releaseReply = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const retry = Promise.withResolvers<void>();
    const behavior = { drop: "", dropped: false };
    const receiver = miraComputerReceiver(f.client);
    let server: ReturnType<typeof Bun.serve> | undefined;
    let port = 0;
    let running: Promise<unknown> | undefined;
    const listen = () => {
        server = Bun.serve({
            hostname: "127.0.0.1",
            port,
            tls,
            async fetch(request) {
                const route = new URL(request.url).pathname.split("/").at(-1)!;
                const result = await receiver(request);
                if (route === "connect" && result.ok) events.push("connect");
                const body: unknown =
                    route === behavior.drop && result.ok
                        ? await result.clone().json()
                        : null;
                if (
                    route === behavior.drop &&
                    !behavior.dropped &&
                    body &&
                    typeof body === "object" &&
                    (route !== "claim" || ("command" in body && body.command))
                ) {
                    behavior.dropped = true;
                    // The real receiver has committed, but the TCP connection will
                    // disappear before the companion can read its response.
                    await releaseReply.promise;
                }
                return result;
            },
        });
        port = server.port!;
    };
    const close = async () => {
        stop.abort();
        releaseReply.resolve();
        releaseCleanup.resolve();
        retry.resolve();
        for (const prompt of prompts) prompt.allow();
        try {
            await running;
        } finally {
            try {
                await server?.stop(true);
            } finally {
                await f.close();
            }
        }
    };
    try {
        listen();
        const companion = new ComputerCompanion(
            `https://127.0.0.1:${port}`,
            (url, init) =>
                fetch(url, {
                    ...init,
                    tls: { ca: tls.cert, rejectUnauthorized: true },
                    proxy: false,
                })
        );
        const api = appRouter.createCaller({
            operations: f,
            principal: { kind: "human", id: "operator", capabilities },
            verifyHuman: () =>
                Promise.resolve({ kind: "human", id: "operator", capabilities }),
        }).mira;
        const chat = await api.conversations.create({ title: "Synthetic reconnect" });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Synthetic run",
            attachmentIds: [],
        });
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        if (!run) throw new Error("Missing synthetic run.");
        const worker = {
            client: f.client,
            owner: "operator",
            actor: `mira:${run.id}`,
            run: { id: run.id, leaseToken: run.leaseToken },
        };
        const pair = await api.computers.pair({ label: "Synthetic reconnect PC" });
        const device = await companion.enroll(
            pair.token,
            { installationId: crypto.randomUUID(), platform: "win32", version: "0.10.0" },
            stop.signal
        );
        const createHost = (): ComputerConsentHost => {
            const local = new AbortController();
            const choice = Promise.withResolvers<ComputerWindowGrant | null>();
            let selected = false;
            return {
                signal: local.signal,
                select: (request, signal) => {
                    selected = true;
                    prompts.push({
                        id: request.id,
                        allow: () =>
                            choice.resolve({
                                executable: path.resolve("synthetic-window"),
                                pid: 123,
                                windowId: "456",
                                delivery: "foreground",
                            }),
                    });
                    signal.addEventListener("abort", () => choice.resolve(null), {
                        once: true,
                    });
                    return choice.promise;
                },
                assertReady: () => Promise.resolve(),
                open: () => {
                    events.push("open");
                    return Promise.resolve({
                        observe: () =>
                            Promise.resolve({
                                snapshot: "synthetic",
                                width: 390,
                                height: 110,
                                content: {
                                    content: [
                                        {
                                            type: "image",
                                            mediaType: "image/png",
                                            data: createVisualChallenge().data,
                                        },
                                    ],
                                },
                            }),
                        type: (text) => {
                            input.push(text);
                            return Promise.resolve({ effect: "confirmed" });
                        },
                        click: () =>
                            Promise.reject(new Error("Unexpected fixture click.")),
                        clickElement: () =>
                            Promise.reject(
                                new Error("Unexpected fixture element input.")
                            ),
                        close: async () => {
                            events.push("closing");
                            await releaseCleanup.promise;
                            events.push("closed");
                        },
                    });
                },
                close: () => {
                    local.abort();
                    choice.resolve(null);
                    if (selected) events.push("host-closed");
                    return Promise.resolve();
                },
            };
        };
        const start = () => {
            running = runComputerPresence({
                companion,
                credential: device.credential,
                expiresAt: device.expiresAt,
                signal: stop.signal,
                status: (state) => events.push(state),
                connectionWork: computerConnectionWork({
                    companion,
                    credential: device.credential,
                    createHost,
                }),
                wait: async (ms, signal) => {
                    if (ms === 30_000) {
                        events.push("retry");
                        await retry.promise;
                        signal.throwIfAborted();
                    } else await delay(ms, undefined, { signal });
                },
            }).then(
                () => null,
                (error: unknown) => error
            );
            return running;
        };
        const request = () =>
            api.computers.access.request({
                computerId: pair.id,
                computerVersion: 2,
                runId: run.id,
                mode: "control",
            });
        const enqueue = async (
            operation:
                | { action: "observe" }
                | { action: "type"; text: string; observationId: string }
        ) => {
            const id = crypto.randomUUID();
            await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${id},${run.id},${crypto.randomUUID()},${operation.action === "observe" ? "mira_computer_observe" : "mira_computer_input"},'synthetic','running')`;
            return enqueueMiraComputerCommand(worker, id, operation);
        };
        const observe = async () => {
            const queued = await enqueue({ action: "observe" });
            await until(async () => {
                const [row] = await f.client<
                    { state: string }[]
                >`SELECT state FROM mira_computer_commands WHERE id=${queued.id}`;
                return row?.state === "completed";
            });
            const received = await takeMiraComputerCommand(worker, queued.id);
            if (
                received.state !== "completed" ||
                !received.result ||
                !("observationId" in received.result)
            )
                throw new Error("Missing observation.");
            return received.result.observationId;
        };
        const disconnect = async () => {
            await until(() => behavior.dropped);
            const stopping = server!.stop(true);
            releaseReply.resolve();
            await stopping;
            server = undefined;
        };
        return {
            ...f,
            companion,
            device,
            api,
            worker,
            events,
            prompts,
            input,
            behavior,
            releaseCleanup,
            retry,
            start,
            request,
            enqueue,
            observe,
            disconnect,
            listen,
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}

test("real HTTPS reconnect retires a lost claim and requires fresh local consent before new input", async () => {
    const f = await fixture();
    const running = f.start();
    try {
        await until(() => f.events.includes("connected"));
        const first = await f.request();
        await until(() => f.prompts.length === 1);
        f.prompts[0]!.allow();
        await until(() => f.events.includes("open"));
        const operation = {
            action: "type" as const,
            text: "must never be replayed",
            observationId: await f.observe(),
        };
        f.behavior.drop = "claim";
        const command = await f.enqueue(operation);
        await f.disconnect();
        await until(() => f.events.includes("closing"));
        expect(f.events).not.toContain("retry");
        expect(f.events.filter((event) => event === "connect")).toHaveLength(1);
        expect(f.input).toEqual([]);
        const [claimed] = await f.client<
            { state: string; payload: unknown }[]
        >`SELECT state,payload FROM mira_computer_commands WHERE id=${command.id}`;
        expect(claimed).toEqual({ state: "claimed", payload: null });
        f.releaseCleanup.resolve();
        await until(() => f.events.includes("retry"));
        expect(f.events.indexOf("closed")).toBeLessThan(f.events.indexOf("retry"));
        const [old] = await f.client<
            { connectionId: string; targetId: string }[]
        >`SELECT connection_id AS "connectionId",target_id AS "targetId" FROM mira_computer_commands WHERE id=${command.id}`;
        expect(old).toBeDefined();
        f.listen();
        f.retry.resolve();
        await until(() => f.events.filter((event) => event === "connect").length === 2);
        expect(await takeMiraComputerCommand(f.worker, command.id)).toEqual({
            state: "unknown",
        });
        const [row] = await f.client<
            { payload: unknown; result: unknown }[]
        >`SELECT payload,result FROM mira_computer_commands WHERE id=${command.id}`;
        expect(row).toEqual({ payload: null, result: null });
        expect(f.prompts).toHaveLength(1);
        expect(f.events.filter((event) => event === "open")).toHaveLength(1);
        await rejects(
            f.companion.heartbeat(
                f.device.credential,
                old!.connectionId,
                100,
                new AbortController().signal
            )
        );
        await rejects(
            f.companion.finishCommand(
                f.device.credential,
                {
                    ...old!,
                    accessId: first.id,
                    commandId: command.id,
                    operation,
                    validForMs: 5000,
                },
                { effect: "confirmed" },
                new AbortController().signal
            )
        );
        const second = await f.request();
        expect(second.id).not.toBe(first.id);
        await until(() => f.prompts.length === 2);
        expect(f.prompts[1]!.id).toBe(second.id);
        expect(f.events.filter((event) => event === "open")).toHaveLength(1);
        f.prompts[1]!.allow();
        await until(() => f.events.filter((event) => event === "open").length === 2);
        const fresh = await f.enqueue({
            action: "type",
            text: "freshly authorized input",
            observationId: await f.observe(),
        });
        await until(async () => {
            const result = await takeMiraComputerCommand(f.worker, fresh.id);
            return result.state === "completed";
        });
        expect(f.input).toEqual(["freshly authorized input"]);
    } finally {
        await f.close();
    }
    expect(await running).toBeNull();
}, 30_000);

test("a lost HTTPS input acknowledgement is terminal even after native input and server completion succeeded", async () => {
    const f = await fixture();
    const running = f.start();
    try {
        await until(() => f.events.includes("connected"));
        await f.request();
        await until(() => f.prompts.length === 1);
        f.prompts[0]!.allow();
        await until(() => f.events.includes("open"));
        const operation = {
            action: "type" as const,
            text: "delivered exactly once",
            observationId: await f.observe(),
        };
        f.behavior.drop = "finish";
        const command = await f.enqueue(operation);
        await f.disconnect();
        await until(() => f.events.includes("closing"));
        expect(f.input).toEqual(["delivered exactly once"]);
        const [committed] = await f.client<
            { state: string }[]
        >`SELECT state FROM mira_computer_commands WHERE id=${command.id}`;
        expect(committed?.state).toBe("completed");
        f.releaseCleanup.resolve();
        expect(await running).toBeInstanceOf(RuntimeCleanupError);
        expect(f.events).not.toContain("retry");
        expect(f.events.filter((event) => event === "connect")).toHaveLength(1);
        expect(f.events.at(-1)).toBe("stopped");
        // An explicit new connection can restore presence, never the old command.
        f.listen();
        await f.companion.connect(f.device.credential, new AbortController().signal);
        expect(await takeMiraComputerCommand(f.worker, command.id)).toEqual({
            state: "unknown",
        });
        expect(f.prompts).toHaveLength(1);
        expect(f.input).toEqual(["delivered exactly once"]);
    } finally {
        await f.close();
    }
}, 30_000);
