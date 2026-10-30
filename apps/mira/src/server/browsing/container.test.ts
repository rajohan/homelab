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
    type BrowserContainerJournal,
} from "./container";
import type { BrowserDockerRequest, BrowserDockerResponse } from "./docker";
import {
    browserProfileVolume,
    inspectBrowserProfile,
    createBrowserProfileVolume,
    removeBrowserProfileVolume,
} from "./profile";
import { reconcileBrowserContainer } from "./reconciliation";

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

function journal(events: string[]): BrowserContainerJournal {
    return {
        owner: crypto.randomUUID(),
        creating: () => {
            events.push("creating");
            return Promise.resolve();
        },
        created: (id) => {
            events.push(`created:${id}`);
            return Promise.resolve();
        },
        rejected: () => Promise.resolve(),
        discovered: () => {
            events.push("discovered");
            return Promise.resolve();
        },
        starting: () => {
            events.push("starting");
            return Promise.resolve();
        },
        cleaning: () => {
            events.push("cleaning");
            return Promise.resolve();
        },
        cleaned: (proof) => {
            events.push(`cleaned:${proof.kind}`);
            return Promise.resolve();
        },
    };
}

test("durable identity and journal writes precede Docker creation, startup and capacity release", async () => {
    const f = await fixture(),
        events: string[] = [],
        log = journal(events);
    const original = f.transport.request;
    const transport: BrowserDockerRequest = async (...args) => {
        events.push(args[0] + ":" + args[1]);
        return original(...args);
    };
    try {
        const lease = await prepareBrowserContainer(
            f.config,
            f.controller.signal,
            transport,
            log
        );
        expect(lease.name).toBe(`mira-browser-${log.owner}`);
        expect(f.state.label).toBe(log.owner);
        await lease.start();
        await lease.close();
        expect(events).toEqual([
            "creating",
            `POST:/containers/create?name=${lease.name}`,
            `created:${id}`,
            `GET:/containers/${id}/json`,
            `GET:/containers/${id}/json`,
            "starting",
            `POST:/containers/${id}/start`,
            "cleaning",
            `GET:/containers/${id}/json`,
            "discovered",
            `DELETE:/containers/${id}?force=1&v=1`,
            `GET:/containers/${id}/json`,
            "cleaned:removed",
        ]);
    } finally {
        await f.cleanup();
    }
});

test("cancellation during durable create intent settles only a stopped container and then removes it", async () => {
    const f = await fixture(),
        events: string[] = [],
        log = journal(events);
    const entered = Promise.withResolvers<void>(),
        resume = Promise.withResolvers<void>();
    log.creating = async () => {
        entered.resolve();
        await resume.promise;
    };
    try {
        const opening = prepareBrowserContainer(
            f.config,
            f.controller.signal,
            f.transport.request,
            log
        );
        const failed = assert.rejects(opening);
        await entered.promise;
        f.controller.abort();
        expect(f.calls).toHaveLength(0);
        resume.resolve();
        await failed;
        expect(f.state.removes).toBe(1);
        expect(f.calls.some((c) => c.route.endsWith("/start"))).toBe(false);
        expect(events.at(-1)).toBe("cleaned:removed");
    } finally {
        resume.resolve();
        await f.cleanup();
    }
});

test("journal failures never start a container or release an unproved lifetime", async () => {
    for (const stage of [
        "creating",
        "created",
        "starting",
        "cleaning",
        "cleaned",
    ] as const) {
        const f = await fixture(),
            events: string[] = [],
            log = journal(events);
        log[stage] = () => Promise.reject(new Error("Synthetic controller replacement"));
        try {
            if (stage === "creating" || stage === "created") {
                await assert.rejects(
                    prepareBrowserContainer(
                        f.config,
                        f.controller.signal,
                        f.transport.request,
                        log
                    )
                );
                expect(f.calls.some((c) => c.route.endsWith("/start"))).toBe(false);
                if (stage === "creating") expect(f.calls).toHaveLength(0);
            } else {
                const lease = await prepareBrowserContainer(
                    f.config,
                    f.controller.signal,
                    f.transport.request,
                    log
                );
                if (stage === "starting") {
                    await assert.rejects(lease.start());
                    expect(f.calls.some((c) => c.route.endsWith("/start"))).toBe(false);
                } else {
                    await assert.rejects(lease.close(), BrowserContainerCleanupError);
                    const count = f.calls.length;
                    await assert.rejects(lease.close(), BrowserContainerCleanupError);
                    expect(f.calls).toHaveLength(count);
                    if (stage === "cleaning") expect(f.state.removes).toBe(0);
                }
            }
        } finally {
            await f.cleanup();
        }
    }
});

test("reconciliation removes only the original verified lifetime and never creates or starts", async () => {
    for (const phase of ["reserved", "creating", "created"] as const) {
        const f = await fixture(),
            owner = crypto.randomUUID();
        let checks = 0;
        f.state.label = owner;
        f.state.exists = phase !== "reserved";
        try {
            const proof = await reconcileBrowserContainer(
                f.config,
                {
                    id: owner,
                    phase,
                    containerId: phase === "created" ? id : null,
                },
                () => {
                    checks++;
                    return Promise.resolve();
                },
                () => Promise.resolve(),
                f.transport.request
            );
            expect(proof).toEqual(
                phase === "reserved"
                    ? { kind: "not-created" }
                    : { kind: "removed", containerId: id }
            );
            expect(checks).toBe(phase === "reserved" ? 1 : 4);
            expect(f.calls.some((c) => c.method === "POST")).toBe(false);
            expect(f.state.exists).toBe(false);
        } finally {
            await f.cleanup();
        }
    }
});

test("unknown create absence cannot release capacity while an exact known ID can", async () => {
    const f = await fixture(),
        owner = crypto.randomUUID();
    try {
        await assert.rejects(
            reconcileBrowserContainer(
                f.config,
                { id: owner, phase: "creating", containerId: null },
                async () => {},
                () => Promise.resolve(),
                f.transport.request
            ),
            BrowserContainerCleanupError
        );
        expect(
            await reconcileBrowserContainer(
                f.config,
                { id: owner, phase: "created", containerId: id },
                async () => {},
                () => Promise.resolve(),
                f.transport.request
            )
        ).toEqual({ kind: "absent", containerId: id });
        for (const record of [
            { id: owner, phase: "reserved", containerId: id },
            { id: owner, phase: "created", containerId: null },
        ])
            await assert.rejects(
                reconcileBrowserContainer(
                    f.config,
                    record,
                    async () => {},
                    () => Promise.resolve(),
                    f.transport.request
                )
            );
    } finally {
        await f.cleanup();
    }
});

test("recovery rejects foreign ownership and rechecks controller authority before deletion", async () => {
    for (const fault of [
        "owner",
        "image",
        "id",
        "controller",
        "removal",
        "survives",
    ] as const) {
        const f = await fixture(),
            owner = crypto.randomUUID();
        f.state.label = owner;
        f.state.exists = true;
        if (fault === "owner") f.state.label = crypto.randomUUID();
        if (fault === "image") f.state.image = `sha256:${"c".repeat(64)}`;
        if (fault === "id") f.state.id = "c".repeat(64);
        let checks = 0;
        const original = f.transport.request;
        const transport: BrowserDockerRequest = (method, route, body) =>
            method === "DELETE" && ["removal", "survives"].includes(fault)
                ? Promise.resolve({ status: fault === "removal" ? 503 : 204, body: null })
                : original(method, route, body);
        try {
            await assert.rejects(
                reconcileBrowserContainer(
                    f.config,
                    { id: owner, phase: "created", containerId: id },
                    () => {
                        if (++checks === 2 && fault === "controller")
                            return Promise.reject(new Error("Replaced controller"));
                        return Promise.resolve();
                    },
                    () => Promise.resolve(),
                    transport
                )
            );
            expect(f.state.removes).toBe(0);
            expect(f.state.exists).toBe(true);
        } finally {
            await f.cleanup();
        }
    }
});

test("saved profiles use one fixed owned volume and reject driver options, foreign labels and paths", async () => {
    const profile = { id: crypto.randomUUID() };
    const expected = {
        Name: browserProfileVolume(profile),
        Driver: "local",
        Scope: "local",
        Labels: { "io.homelab.mira.browser-profile": profile.id },
        Options: null,
    };
    const spec = browserContainerSpec(image, crypto.randomUUID(), undefined, profile);
    expect(spec.HostConfig.Mounts).toEqual([
        {
            Type: "volume",
            Source: expected.Name,
            Target: "/var/lib/mira-browser-profile",
            ReadOnly: false,
            VolumeOptions: { NoCopy: false },
        },
    ]);
    expect(spec.Env).toContain("MIRA_BROWSER_PROFILE=saved");
    expect(spec.HostConfig.Binds).toEqual([]);
    expect(() => browserProfileVolume({ id: "../../operator" })).toThrow();
    for (const invalid of [
        { Driver: "external" },
        { Scope: "global" },
        { Name: "foreign" },
        { Options: { device: "/home/operator", type: "none", o: "bind" } },
        { Labels: {} },
    ]) {
        const request: BrowserDockerRequest = () =>
            Promise.resolve({ status: 200, body: { ...expected, ...invalid } });
        await assert.rejects(inspectBrowserProfile(request, profile));
        await assert.rejects(removeBrowserProfileVolume(request, profile));
    }
    let exists = false;
    const calls: string[] = [];
    const request: BrowserDockerRequest = (method, route, body) => {
        calls.push(`${method} ${route}`);
        if (method === "POST") {
            expect(body).toEqual({
                Name: expected.Name,
                Driver: "local",
                DriverOpts: {},
                Labels: expected.Labels,
            });
            exists = true;
            return Promise.resolve({ status: 201, body: expected });
        }
        if (method === "DELETE") {
            expect(route).toBe(`/volumes/${expected.Name}`);
            exists = false;
            return Promise.resolve({ status: 204, body: null });
        }
        return Promise.resolve({
            status: exists ? 200 : 404,
            body: exists ? expected : null,
        });
    };
    await createBrowserProfileVolume(request, profile);
    expect(await inspectBrowserProfile(request, profile)).toBe(true);
    await removeBrowserProfileVolume(request, profile);
    expect(await inspectBrowserProfile(request, profile)).toBe(false);
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual([
        `DELETE /volumes/${expected.Name}`,
    ]);
    await assert.rejects(
        createBrowserProfileVolume(
            () => Promise.resolve({ status: 500, body: null }),
            profile
        )
    );
    await assert.rejects(
        inspectBrowserProfile(() => Promise.resolve({ status: 500, body: null }), profile)
    );
    await assert.rejects(
        removeBrowserProfileVolume(
            (method) =>
                Promise.resolve({
                    status: method === "DELETE" ? 409 : 200,
                    body: expected,
                }),
            profile
        )
    );
});
