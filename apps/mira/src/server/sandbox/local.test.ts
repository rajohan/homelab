import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { BrowserDockerRequest } from "../browsing/docker";
import type { BrowserEgress } from "../browsing/egress";
import { sandboxProxyEnvironment } from "../config/environment";
import { browserEgressFixture } from "../testing/browserEgressFixture";
import {
    cleanupLocalCodeContainer,
    executeLocalCodeCheck,
    localCodeContainerSpec,
    type LocalCodeJournal,
} from "./localContainer";
import { runLocalCheck } from "./localHarness";
import {
    parseLocalCheckInput,
    parseLocalCheckResult,
    type LocalCheckResult,
} from "./localProtocol";

const owner = "11111111-1111-4111-8111-111111111111";
const imageId = `sha256:${"b".repeat(64)}`;
const containerId = "c".repeat(64);
const input = {
    request: { id: owner, commit: "a".repeat(40), patchSha256: null },
    input: null,
};
const result: LocalCheckResult = {
    exitCode: 0,
    files: (["check-result.json", "check-log.txt", "changes.txt"] as const).map(
        (name) => ({
            name,
            text: "fixture",
        })
    ),
};

async function fixture() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mira-local-check-"));
    const socketPath = path.join(directory, "docker.sock");
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
    const config: { socketPath: string; imageId: string; egress?: BrowserEgress } = {
        socketPath,
        imageId,
    };
    const events: string[] = [];
    const state = {
        exists: false,
        label: owner,
        started: false,
        reply: JSON.stringify(result),
        received: "",
    };
    const controller = new AbortController();
    const journal: LocalCodeJournal = {
        creating: () => {
            events.push("intent");
            return Promise.resolve();
        },
        created: (id) => {
            expect(id).toBe(containerId);
            events.push("receipt");
            return Promise.resolve();
        },
        rejected: () => {
            events.push("rejected");
            return Promise.resolve();
        },
        starting: () => {
            events.push("authorize");
            return Promise.resolve();
        },
        cleaning: () => {
            events.push("cleaning");
            return Promise.resolve();
        },
        discovered: (id) => {
            expect(id).toBe(containerId);
            events.push("discovered");
            return Promise.resolve();
        },
        cleaned: () => {
            events.push("confirmed");
            return Promise.resolve();
        },
    };
    const request: BrowserDockerRequest = (method, route) => {
        if (route.startsWith("/containers/create?")) {
            events.push("create");
            state.exists = true;
            return Promise.resolve({ status: 201, body: { Id: containerId } });
        }
        if (method === "GET")
            return Promise.resolve(
                state.exists
                    ? {
                          status: 200,
                          body: {
                              Id: containerId,
                              Image: imageId,
                              Config: {
                                  Labels: { "io.homelab.mira.code-owner": state.label },
                              },
                          },
                      }
                    : { status: 404, body: null }
            );
        if (method === "DELETE") {
            events.push("remove");
            state.exists = false;
            return Promise.resolve({ status: 204, body: null });
        }
        if (route.endsWith("/start")) {
            events.push("start");
            state.started = true;
            return Promise.resolve({ status: 204, body: null });
        }
        return Promise.reject(new Error("Unexpected fixture request."));
    };
    const dependencies = {
        request,
        journalTimeoutMs: 100,
        executionTimeoutMs: 650_000,
        attach: () =>
            Promise.resolve(
                new Duplex({
                    read() {},
                    write(chunk: Buffer, _encoding, callback) {
                        state.received += chunk.toString();
                        callback();
                        if (state.reply === "pending") return;
                        if (state.reply === "hold") {
                            controller.abort();
                            return;
                        }
                        const body = Buffer.from(state.reply + "\n");
                        const header = Buffer.alloc(8);
                        header[0] = 1;
                        header.writeUInt32BE(body.length, 4);
                        this.push(Buffer.concat([header, body]));
                    },
                })
            ),
    };
    return {
        config,
        events,
        state,
        controller,
        journal,
        dependencies,
        run: () =>
            executeLocalCodeCheck(
                config,
                input,
                journal,
                controller.signal,
                dependencies
            ),
        close: async () => {
            await new Promise<void>((resolve) => socket.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        },
    };
}

test("local code containers accept only a fixed immutable non-root profile without host access", () => {
    const spec = localCodeContainerSpec(
        { socketPath: "/run/docker.sock", imageId },
        owner
    );
    expect(spec).toMatchObject({
        User: "postgres",
        NetworkDisabled: true,
        OpenStdin: true,
        Cmd: [
            "--signal=KILL",
            "660s",
            "bun",
            "--no-env-file",
            "/opt/homelab/local-check.js",
        ],
        HostConfig: {
            Binds: [],
            PortBindings: {},
            NetworkMode: "none",
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            NanoCpus: 4_000_000_000,
            Memory: 8 * 1024 ** 3,
        },
    });
    expect(() =>
        localCodeContainerSpec(
            { socketPath: "/run/docker.sock", imageId: "latest" },
            owner
        )
    ).toThrow();
    expect(() =>
        localCodeContainerSpec({ socketPath: "/run/docker.sock", imageId }, "../../other")
    ).toThrow();
});

test("local profile rejects mismatched inputs, excessive outputs and host execution", async () => {
    expect(parseLocalCheckInput(input)).toEqual(input);
    const content = "reviewed diff";
    const digest = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    expect(
        parseLocalCheckInput({
            request: { ...input.request, patchSha256: digest },
            input: content,
        }).input
    ).toBe(content);
    for (const invalid of [
        { ...input, input: content },
        { request: { ...input.request, patchSha256: digest }, input: null },
        { request: { ...input.request, patchSha256: digest }, input: "other" },
        { ...input, command: "touch /host" },
        { ...input, input: "x".repeat(1_048_577) },
    ])
        expect(() => parseLocalCheckInput(invalid)).toThrow();
    expect(parseLocalCheckResult(result, input.request)).toEqual(result);
    for (const files of [
        result.files.slice(0, 2),
        [...result.files, result.files[0]],
        result.files.map((file) => ({ ...file, text: "x".repeat(1_048_577) })),
        result.files.map((file) => ({ ...file, name: "../../host" })),
    ])
        expect(() =>
            parseLocalCheckResult({ ...result, files }, input.request)
        ).toThrow();
    await assert.rejects(
        runLocalCheck(input, new AbortController().signal),
        /qualified non-root/
    );
});

test("local checks bind intent, receipt and startup before sending input and confirm cleanup before return", async () => {
    const f = await fixture();
    try {
        expect(await f.run()).toEqual(result);
        expect(JSON.parse(f.state.received)).toEqual(input);
        expect(f.events).toEqual([
            "intent",
            "create",
            "receipt",
            "authorize",
            "start",
            "cleaning",
            "discovered",
            "remove",
            "confirmed",
        ]);
        expect(f.state.exists).toBe(false);
    } finally {
        await f.close();
    }
});

test("revoked startup, interrupted output and malformed replies stop without replaying", async () => {
    for (const failure of ["before-start", "hold", "invalid-json"]) {
        const f = await fixture();
        try {
            if (failure === "before-start")
                f.journal.starting = () => {
                    f.controller.abort();
                    return Promise.resolve();
                };
            else f.state.reply = failure;
            await assert.rejects(f.run());
            expect(f.events.filter((event) => event === "create")).toHaveLength(1);
            expect(f.state.exists).toBe(false);
            expect(f.events.at(-1)).toBe("confirmed");
            if (failure === "before-start") expect(f.state.started).toBe(false);
        } finally {
            await f.close();
        }
    }
});

test("unknown creation stays reserved, while a discovered owned container can be recovered", async () => {
    const f = await fixture();
    try {
        f.dependencies.request = () => Promise.reject(new Error("Lost acknowledgement"));
        await assert.rejects(f.run());
        expect(f.events).not.toContain("confirmed");
        await assert.rejects(
            cleanupLocalCodeContainer(
                f.config,
                { id: owner, settled: false },
                f.journal,
                () => Promise.resolve({ status: 404, body: null })
            ),
            /uncertain/
        );
        expect(f.events).not.toContain("confirmed");
        let exists = true;
        await cleanupLocalCodeContainer(
            f.config,
            { id: owner, settled: false },
            f.journal,
            (method) => {
                if (method === "DELETE") {
                    exists = false;
                    return Promise.resolve({ status: 204, body: null });
                }
                return Promise.resolve(
                    exists
                        ? {
                              status: 200,
                              body: {
                                  Id: containerId,
                                  Image: imageId,
                                  Config: {
                                      Labels: { "io.homelab.mira.code-owner": owner },
                                  },
                              },
                          }
                        : { status: 404, body: null }
                );
            }
        );
        expect(exists).toBe(false);
        expect(f.events.at(-1)).toBe("confirmed");
    } finally {
        await f.close();
    }
});

test("cleanup removes owned work even when its database journal fails, but never another owner's container", async () => {
    for (const failure of ["journal", "owner"]) {
        const f = await fixture();
        try {
            if (failure === "journal")
                f.journal.cleaning = () =>
                    Promise.reject(new Error("Database unavailable"));
            else f.state.label = "other-owner";
            await assert.rejects(f.run());
            expect(f.events).not.toContain("confirmed");
            expect(f.state.exists).toBe(failure === "owner");
            expect(f.events.includes("remove")).toBe(failure === "journal");
        } finally {
            await f.close();
        }
    }
});

test("stalled lifecycle writes cannot hold resources or ignore cancellation", async () => {
    for (const phase of [
        "creating",
        "created",
        "starting",
        "cleaning",
        "discovered",
        "cleaned",
    ] as const) {
        const f = await fixture();
        let deadline: AbortSignal | undefined;
        const stalled = (signal: AbortSignal) => {
            deadline = signal;
            if (phase === "created") setTimeout(() => f.controller.abort(), 5);
            return new Promise<void>(() => {});
        };
        switch (phase) {
            case "created":
            case "discovered": {
                f.journal[phase] = (_id, signal) => stalled(signal);
                break;
            }
            default: {
                f.journal[phase] = stalled;
            }
        }
        try {
            await assert.rejects(f.run());
            expect(deadline?.aborted).toBe(true);
            expect(f.state.exists).toBe(false);
            if (phase === "creating") expect(f.events).not.toContain("create");
            else expect(f.events).toContain("remove");
            if (["created", "starting"].includes(phase)) {
                expect(f.state.started).toBe(false);
                expect(f.events).toContain("confirmed");
            }
            if (["cleaning", "discovered", "cleaned"].includes(phase))
                expect(f.events).not.toContain("confirmed");
        } finally {
            await f.close();
        }
    }
});

test("slow Engine cleanup does not consume the final journal write's deadline", async () => {
    const f = await fixture();
    const request = f.dependencies.request;
    f.dependencies.request = async (method, route, body) => {
        if (method === "DELETE") await delay(150);
        return request(method, route, body);
    };
    try {
        expect(await f.run()).toEqual(result);
        expect(f.state.exists).toBe(false);
        expect(f.events.at(-1)).toBe("confirmed");
    } finally {
        await f.close();
    }
});

test("the execution deadline starts after setup and still removes a stalled running check", async () => {
    for (const pending of [false, true]) {
        const f = await fixture();
        const request = f.dependencies.request;
        f.dependencies.executionTimeoutMs = 100;
        f.dependencies.request = async (method, route, body) => {
            if (route.startsWith("/containers/create?")) await delay(150);
            return request(method, route, body);
        };
        if (pending) f.state.reply = "pending";
        try {
            if (pending) await assert.rejects(f.run(), /interrupted/);
            else expect(await f.run()).toEqual(result);
            expect(f.state.started).toBe(true);
            expect(f.state.exists).toBe(false);
            expect(f.events.at(-1)).toBe("confirmed");
        } finally {
            await f.close();
        }
    }
});

test("socket loss still retires the durable attempt before cleanup becomes unavailable", async () => {
    const f = await fixture();
    const request = f.dependencies.request;
    f.dependencies.request = async (method, route, body) => {
        const reply = await request(method, route, body);
        if (route.endsWith("/start")) await unlink(f.config.socketPath);
        return reply;
    };
    f.state.reply = "hold";
    try {
        await assert.rejects(f.run());
        expect(f.state.started).toBe(true);
        expect(f.events.at(-1)).toBe("cleaning");
        expect(f.events).not.toContain("confirmed");
    } finally {
        await f.close();
    }
});

test("a result waits for pending egress verification and rejects lost isolation", async () => {
    const f = await fixture();
    const egress = browserEgressFixture();
    f.config.egress = egress.config;
    f.state.reply = "pending";
    const request = f.dependencies.request;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let checks = 0;
    f.dependencies.request = async (method, route, body) => {
        if (method === "GET" && route in egress.replies) {
            if (route.startsWith("/networks/") && ++checks === 3) {
                entered.resolve();
                await release.promise;
            }
            return {
                status: 200,
                body:
                    route === `/containers/${containerId}/json`
                        ? {
                              ...egress.browser,
                              Image: imageId,
                              Config: { Labels: { "io.homelab.mira.code-owner": owner } },
                          }
                        : egress.replies[route],
            };
        }
        const reply = await request(method, route, body);
        if (route.startsWith("/containers/create?"))
            egress.network.Containers[containerId] = {};
        if (method === "DELETE") {
            delete egress.network.Containers[containerId];
            delete egress.replies[`/containers/${containerId}/json`];
        }
        return reply;
    };
    const attach = f.dependencies.attach;
    let channel: Duplex | undefined;
    f.dependencies.attach = async () => {
        channel = await attach();
        return channel;
    };
    let settled = false;
    const running = f.run().finally(() => {
        settled = true;
    });
    const rejected = assert.rejects(running);
    try {
        await entered.promise;
        const body = Buffer.from(JSON.stringify(result) + "\n");
        const header = Buffer.alloc(8);
        header[0] = 1;
        header.writeUInt32BE(body.length, 4);
        channel!.push(Buffer.concat([header, body]));
        await delay(10);
        expect(settled).toBe(false);
        expect(f.events).not.toContain("remove");
        egress.proxy.State.Health.Status = "unhealthy";
        release.resolve();
        await rejected;
        expect(f.state.exists).toBe(false);
        expect(f.events.at(-1)).toBe("confirmed");
    } finally {
        release.resolve();
        f.controller.abort();
        await rejected;
        await f.close();
    }
});

test("local network mode exports only the fixed proxy and never inherited credentials", () => {
    const previous = process.env.HOMELAB_MIRA_LOCAL_EGRESS;
    try {
        delete process.env.HOMELAB_MIRA_LOCAL_EGRESS;
        expect(sandboxProxyEnvironment()).toEqual({});
        process.env.HOMELAB_MIRA_LOCAL_EGRESS = "public";
        expect(sandboxProxyEnvironment()).toMatchObject({
            HTTPS_PROXY: "http://mira-egress:3128",
            NO_PROXY: "127.0.0.1,localhost,::1",
        });
        process.env.HOMELAB_MIRA_LOCAL_EGRESS = "http://private:secret@example.com";
        expect(() => sandboxProxyEnvironment()).toThrow();
    } finally {
        if (previous === undefined) delete process.env.HOMELAB_MIRA_LOCAL_EGRESS;
        else process.env.HOMELAB_MIRA_LOCAL_EGRESS = previous;
    }
});
