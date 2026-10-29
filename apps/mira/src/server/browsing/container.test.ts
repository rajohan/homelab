import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import {
    BrowserContainerCleanupError,
    browserContainerSpec,
    prepareBrowserContainer,
} from "./container";
import type { BrowserDockerRequest, BrowserDockerResponse } from "./docker";

const image = `sha256:${"b".repeat(64)}`;
const id = "a".repeat(64);
async function fixture() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-lease-test-"));
    const socket = path.join(directory, "docker.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const controller = new AbortController();
    const state = { exists: false, running: false, label: "", image, id, removes: 0 };
    const calls: { method: string; route: string; body: unknown }[] = [];
    const transport: { request: BrowserDockerRequest } = {
        request: (method, route, body) => {
            calls.push({ method, route, body });
            if (route.startsWith("/containers/create")) {
                state.exists = true;
                state.label = (body as { Labels: Record<string, string> }).Labels[
                    "io.homelab.mira.browser-owner"
                ]!;
                return Promise.resolve({ status: 201, body: { Id: id } });
            }
            if (route.endsWith("/json"))
                return Promise.resolve(
                    state.exists
                        ? {
                              status: 200,
                              body: {
                                  Id: state.id,
                                  Image: state.image,
                                  Config: {
                                      Labels: {
                                          "io.homelab.mira.browser-owner": state.label,
                                      },
                                  },
                              },
                          }
                        : { status: 404, body: null }
                );
            if (route.endsWith("/start")) {
                state.running = true;
                return Promise.resolve({ status: 204, body: null });
            }
            if (method === "DELETE") {
                state.removes++;
                state.exists = false;
                state.running = false;
                return Promise.resolve({ status: 204, body: null });
            }
            return Promise.reject(new Error("Unexpected fixture request"));
        },
    };
    const config = { socketPath: socket, imageId: image };
    return {
        state,
        config,
        transport,
        calls,
        controller,
        open: () =>
            prepareBrowserContainer(config, controller.signal, (...args) =>
                transport.request(...args)
            ),
        cleanup: async () => {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            );
            await rm(directory, { recursive: true, force: true });
        },
    };
}

test("browser containers have immutable images, no host mounts/network and a fixed hard lifetime", () => {
    const spec = browserContainerSpec(image, crypto.randomUUID());
    expect(spec).toMatchObject({
        User: "1000:1000",
        NetworkDisabled: true,
        Entrypoint: ["/usr/bin/timeout"],
        Cmd: ["--signal=KILL", "305s", "/usr/local/bin/mira-browser"],
        StdinOnce: true,
        Tty: false,
    });
    expect(spec.HostConfig).toMatchObject({
        AutoRemove: true,
        Init: true,
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 1_610_612_736,
        NanoCpus: 2_000_000_000,
        PidsLimit: 256,
        Binds: [],
        PortBindings: {},
        LogConfig: { Type: "none" },
        RestartPolicy: { Name: "no" },
    });
    for (const invalid of [
        "latest",
        "ubuntu:latest",
        "https://daemon.invalid",
        `sha256:${"x".repeat(64)}`,
    ])
        expect(() => browserContainerSpec(invalid, crypto.randomUUID())).toThrow();
    expect(() => browserContainerSpec(image, "untrusted-name")).toThrow();
});

test("one owned lease starts once and close verifies removal before returning", async () => {
    const f = await fixture();
    try {
        const lease = await f.open();
        expect(lease.id).toBe(id);
        expect(lease.name).toMatch(/^mira-browser-/);
        expect(f.state.running).toBe(false);
        await lease.start();
        expect(f.state.running).toBe(true);
        await assert.rejects(lease.start(), /again/);
        await Promise.all([lease.close(), lease.close()]);
        expect(f.state.removes).toBe(1);
        expect(f.state.exists).toBe(false);
        expect(lease.signal.aborted).toBe(true);
        expect(f.calls.at(-1)?.route).toBe(`/containers/${id}/json`);
        await assert.rejects(lease.start(), /again/);
    } finally {
        await f.cleanup();
    }
});

test("owner cancellation before creation cannot launch work and after start removes it", async () => {
    const f = await fixture();
    try {
        f.controller.abort();
        await assert.rejects(f.open());
        expect(f.calls).toHaveLength(0);
    } finally {
        await f.cleanup();
    }
    const second = await fixture();
    try {
        const lease = await second.open();
        await lease.start();
        second.controller.abort();
        await lease.close();
        expect(second.state.running).toBe(false);
        expect(second.state.removes).toBe(1);
    } finally {
        await second.cleanup();
    }
});

test("cancellation waits for an in-flight create to settle before proving absence", async () => {
    const f = await fixture();
    const pending = Promise.withResolvers<BrowserDockerResponse>();
    const entered = Promise.withResolvers<void>();
    const real = f.transport.request;
    f.transport.request = async (method, route, body) => {
        if (route.startsWith("/containers/create")) {
            entered.resolve();
            await pending.promise;
        }
        return real(method, route, body);
    };
    try {
        const opening = f.open();
        await entered.promise;
        f.controller.abort();
        expect(f.state.removes).toBe(0);
        pending.resolve({ status: 201, body: { Id: id } });
        await assert.rejects(opening);
        expect(f.state.removes).toBe(1);
        expect(f.state.running).toBe(false);
    } finally {
        await f.cleanup();
    }
});

test("cancellation during start cannot race a late start behind successful cleanup", async () => {
    const f = await fixture();
    const pending = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const real = f.transport.request;
    try {
        const lease = await f.open();
        f.transport.request = async (...args) => {
            if (args[1].endsWith("/start")) {
                entered.resolve();
                await pending.promise;
            }
            return real(...args);
        };
        const starting = lease.start();
        await entered.promise;
        f.controller.abort();
        expect(f.state.removes).toBe(0);
        pending.resolve();
        await assert.rejects(starting);
        await lease.close();
        expect(f.state.running).toBe(false);
        expect(f.state.removes).toBe(1);
    } finally {
        await f.cleanup();
    }
});

test("unknown creation, substituted ownership and failed removal retain a sticky cleanup failure", async () => {
    for (const scenario of [
        "create",
        "owner",
        "image",
        "id",
        "delete",
        "survives",
        "inspect",
    ]) {
        const f = await fixture();
        const real = f.transport.request;
        try {
            if (scenario === "create") {
                f.transport.request = (method, route, body) =>
                    route.startsWith("/containers/create")
                        ? Promise.reject(new Error("request lost"))
                        : real(method, route, body);
                await assert.rejects(f.open(), BrowserContainerCleanupError);
                continue;
            }
            const lease = await f.open();
            if (scenario === "owner") f.state.label = crypto.randomUUID();
            if (scenario === "image") f.state.image = `sha256:${"c".repeat(64)}`;
            if (scenario === "id") f.state.id = "c".repeat(64);
            if (scenario === "delete")
                f.transport.request = (method, route, body) =>
                    method === "DELETE"
                        ? Promise.resolve({ status: 500, body: null })
                        : real(method, route, body);
            if (scenario === "survives")
                f.transport.request = (method, route, body) =>
                    method === "DELETE"
                        ? Promise.resolve({ status: 204, body: null })
                        : real(method, route, body);
            if (scenario === "inspect")
                f.transport.request = () => Promise.resolve({ status: 503, body: null });
            if (["owner", "image", "id"].includes(scenario)) {
                await assert.rejects(lease.start(), BrowserContainerCleanupError);
                expect(f.calls.some((call) => call.route.endsWith("/start"))).toBe(false);
            }
            await assert.rejects(lease.close(), BrowserContainerCleanupError);
            const before = f.calls.length;
            await assert.rejects(lease.close(), BrowserContainerCleanupError);
            await assert.rejects(lease.start(), /again/);
            expect(f.calls).toHaveLength(before);
            if (["owner", "image", "id"].includes(scenario))
                expect(f.state.removes).toBe(0);
        } finally {
            await f.cleanup();
        }
    }
});

test("already-removed containers are clean but a failed start still retires the lease", async () => {
    const f = await fixture();
    try {
        const lease = await f.open();
        f.state.exists = false;
        await assert.rejects(lease.start(), /no longer available/);
        await lease.close();
        expect(f.state.removes).toBe(0);
    } finally {
        await f.cleanup();
    }
    const other = await fixture();
    try {
        const lease = await other.open();
        const real = other.transport.request;
        other.transport.request = (method, route, body) =>
            route.endsWith("/start")
                ? Promise.resolve({ status: 500, body: null })
                : real(method, route, body);
        await assert.rejects(lease.start(), /did not start/);
        await lease.close();
        expect(other.state.exists).toBe(false);
    } finally {
        await other.cleanup();
    }
});

test("remote endpoints, symlinks, ordinary files and unknown launch options are refused", async () => {
    const f = await fixture();
    try {
        const link = path.join(path.dirname(f.config.socketPath), "linked.sock");
        await symlink(f.config.socketPath, link);
        for (const patch of [
            { socketPath: "tcp://remote:2375" },
            { socketPath: link },
            { socketPath: path.dirname(link) },
            { command: "/bin/sh" },
        ])
            await assert.rejects(
                prepareBrowserContainer(
                    { ...f.config, ...patch },
                    f.controller.signal,
                    f.transport.request
                )
            );
        expect(f.calls).toHaveLength(0);
    } finally {
        await f.cleanup();
    }
});

test("documented creation rejections remain actionable without claiming an uncertain cleanup", async () => {
    for (const status of [400, 404, 409]) {
        const f = await fixture();
        const real = f.transport.request;
        try {
            f.transport.request = (method, route, body) =>
                route.startsWith("/containers/create")
                    ? Promise.resolve({ status, body: null })
                    : real(method, route, body);
            await assert.rejects(f.open(), /could not be created/);
            expect(f.state.removes).toBe(0);
        } finally {
            await f.cleanup();
        }
    }
});
