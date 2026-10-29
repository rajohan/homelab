import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createVisualChallenge } from "../testing/visualChallenge";
import { ComputerCompanion } from "./companion";
import { ComputerConsentController } from "./companionConsent";
import {
    type ComputerConsentSurface,
    openComputerConsentSurface,
} from "./consentProcess";
import { issueComputerCredential } from "./credentials";
import { ComputerLocalConsentHost } from "./localConsentHost";
import { computerWindowManifest } from "./policy";
import type { ComputerWindowPort } from "./session";

function deferred<T>() {
    let complete!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        complete = resolve;
    });
    return { promise, resolve: complete };
}
const signal = () => new AbortController().signal;
function fixture(mode: "view" | "control" = "control") {
    const stopped = new AbortController();
    const local = new AbortController();
    const events: string[] = [];
    const request = {
        id: crypto.randomUUID(),
        computerId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        mode,
        state: "pending" as const,
        consentExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    const target = Object.freeze({
        executable: path.resolve("fixture-window"),
        pid: 123,
        windowId: "456",
        delivery: "foreground" as const,
        mode,
    });
    const surface: ComputerConsentSurface = {
        target,
        signal: local.signal,
        assertReady: () => {
            events.push("ready");
            return Promise.resolve();
        },
        close: () => {
            events.push("surface-closed");
            return Promise.resolve();
        },
    };
    const port: ComputerWindowPort = {
        observe: () =>
            Promise.resolve({
                snapshot: "fixture",
                coordinateInput: false,
                elements: [{ token: "s00000001:1", role: "button", label: "Fixture" }],
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
        clickElement: () => {
            events.push("element");
            return Promise.resolve({ effect: "confirmed" });
        },
        click: () => {
            events.push("click");
            return Promise.resolve({ effect: "confirmed" });
        },
        type: () => {
            events.push("type");
            return Promise.resolve({ effect: "confirmed" });
        },
        close: () => {
            events.push("driver-closed");
            return Promise.resolve();
        },
    };
    let driverSignal: AbortSignal | undefined;
    const factories = {
        surface: ((_options) =>
            Promise.resolve(surface)) as typeof openComputerConsentSurface,
        driver: (selected: ComputerConsentSurface["target"], stopped: AbortSignal) => {
            expect(selected).toEqual(target);
            expect(Object.isFrozen(selected)).toBe(true);
            events.push("open");
            driverSignal = stopped;
            return Promise.resolve(port);
        },
    };
    const options = {
        command: process.execPath,
        cwd: process.cwd(),
        args: ["host"],
        environment: {},
        origin: "https://private.example.test",
    };
    const host = new ComputerLocalConsentHost(
        options,
        (target, stopped) => factories.driver(target, stopped),
        (input) => factories.surface(input)
    );
    return {
        host,
        factories,
        options,
        request,
        target,
        surface,
        port,
        events,
        local,
        stopped,
        driverSignal: () => driverSignal,
    };
}

test("local host retains immutable view/control scope and shares cleanup with the controller port", async () => {
    for (const mode of ["view", "control"] as const) {
        const f = fixture(mode);
        let shown: Parameters<typeof openComputerConsentSurface>[0] | undefined;
        f.factories.surface = (options) => {
            shown = options;
            return Promise.resolve(f.surface);
        };
        f.options.origin = "https://changed.example.test";
        f.options.args.push("untrusted-late-argument");
        try {
            const selecting = f.host.select(f.request, f.stopped.signal);
            f.request.mode = mode === "view" ? "control" : "view";
            const target = await selecting;
            expect(target).toEqual(f.target);
            expect(shown?.origin).toBe("https://private.example.test");
            expect(shown?.args).toEqual(["host"]);
            expect(shown?.request.mode).toBe(mode);
            expect(Object.isFrozen(shown?.request)).toBe(true);
            const port = await f.host.open({ ...target! }, f.stopped.signal);
            expect(computerWindowManifest(target).allow.tools).toEqual(
                mode === "view"
                    ? ["get_window_state"]
                    : ["get_window_state", "click", "type_text"]
            );
            await rejects(f.host.select(f.request, signal()), /already requested/);
            await rejects(f.host.open(f.target, signal()), /already opened/);
            await port.close();
        } finally {
            await f.host.close();
        }
        expect(f.driverSignal()?.aborted).toBe(true);
        expect(f.events.filter((event) => event === "driver-closed")).toHaveLength(1);
        expect(f.events.filter((event) => event === "surface-closed")).toHaveLength(1);
    }
});

test("refusal and changed local scope never open a driver", async () => {
    for (const outcome of ["refusal", "scope", "stopped"]) {
        const f = fixture("view");
        f.factories.surface = () => {
            if (outcome === "refusal") return Promise.resolve(null);
            if (outcome === "scope") f.surface.target = { ...f.target, mode: "control" };
            if (outcome === "stopped") f.local.abort();
            return Promise.resolve(f.surface);
        };
        if (outcome === "refusal")
            expect(await f.host.select(f.request, signal())).toBeNull();
        else await rejects(f.host.select(f.request, signal()));
        await rejects(f.host.open(f.target, signal()));
        await f.host.close();
        expect(f.host.signal.aborted).toBe(true);
        expect(f.events).not.toContain("open");
    }
});

test("every selected identity field is bound and cannot be widened by the controller copy", async () => {
    for (const change of [
        { executable: path.resolve("other-window") },
        { pid: 124 },
        { windowId: "457" },
        { startedAt: "999" },
        { delivery: "background" as const },
        { mode: "control" as const },
        { mode: undefined },
    ]) {
        const f = fixture("view");
        await f.host.select(f.request, signal());
        await rejects(f.host.open({ ...f.target, ...change }, signal()));
        expect(f.events).not.toContain("open");
        expect(f.host.signal.aborted).toBe(true);
        await f.host.close();
    }
    const unselected = fixture();
    await rejects(unselected.host.open(unselected.target, signal()));
    expect(unselected.events).not.toContain("open");
    await unselected.host.close();
});

test("stop waits for a late local selection and reaps it without accepting a replacement", async () => {
    const f = fixture();
    const selected = deferred<ComputerConsentSurface | null>();
    const entered = deferred<boolean>();
    f.factories.surface = ({ signal }) => {
        signal.addEventListener("abort", () => f.events.push("prompt-aborted"), {
            once: true,
        });
        entered.resolve(true);
        return selected.promise;
    };
    const selecting = f.host.select(f.request, f.stopped.signal);
    await entered.promise;
    const closing = f.host.close();
    expect(f.host.close()).toBe(closing);
    let closed = false;
    void closing.then(() => {
        return (closed = true);
    });
    await Bun.sleep(1);
    expect(closed).toBe(false);
    expect(f.events).toContain("prompt-aborted");
    selected.resolve(f.surface);
    await rejects(selecting);
    await closing;
    await rejects(f.host.select(f.request, signal()));
    expect(f.events.filter((event) => event === "surface-closed")).toHaveLength(1);
    expect(f.events).not.toContain("open");
});

test("local stop reaps a late starting driver and preserves failed cleanup for replacement gating", async () => {
    for (const fails of [false, true]) {
        const f = fixture();
        const starting = deferred<ComputerWindowPort>();
        const entered = deferred<boolean>();
        f.factories.driver = (_target, signal) => {
            signal.addEventListener("abort", () => f.events.push("driver-aborted"), {
                once: true,
            });
            entered.resolve(true);
            return starting.promise;
        };
        if (fails)
            f.port.close = () => {
                f.events.push("driver-closed");
                return Promise.reject(new Error("reap failed"));
            };
        await f.host.select(f.request, f.stopped.signal);
        const opening = f.host.open(f.target, f.stopped.signal);
        await entered.promise;
        f.local.abort();
        expect(f.host.signal.aborted).toBe(true);
        expect(f.events).toContain("driver-aborted");
        starting.resolve(f.port);
        await rejects(opening);
        if (fails) {
            await rejects(f.host.close(), /cleanup could not be confirmed/);
            await rejects(f.host.close(), /cleanup could not be confirmed/);
        } else await f.host.close();
        expect(f.events.filter((event) => event === "driver-closed")).toHaveLength(1);
        expect(f.events.filter((event) => event === "surface-closed")).toHaveLength(1);
    }
});

test("readiness failure after startup closes both resources even if surface cleanup fails", async () => {
    const f = fixture();
    await f.host.select(f.request, signal());
    const original = f.factories.driver;
    f.factories.driver = (target, signal) => {
        f.surface.assertReady = () => Promise.reject(new Error("session locked"));
        f.surface.close = () => {
            f.events.push("surface-closed");
            return Promise.reject(new Error("reap failed"));
        };
        return original(target, signal);
    };
    await rejects(f.host.open(f.target, signal()), /cleanup could not be confirmed/);
    await rejects(f.host.close());
    expect(f.events).toContain("driver-closed");
    expect(f.events).toContain("surface-closed");
});

test("the real consent pipe composes with server consent and retires idle or in-flight controller work", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-consent-host-test-"));
    const child = path.join(directory, "fixture.ts");
    await Bun.write(
        child,
        `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
        console.log(JSON.stringify({ id: message.id, result: { protocol: 1 } }));
        console.log(JSON.stringify({ method: "consent/selected", params: { target: {
            executable: process.execPath, pid: process.pid, windowId: "456", delivery: "foreground"
        } } }));
    } else console.log(JSON.stringify({ id: message.id, result: { ready: true } }));
}
`
    );
    try {
        for (const operation of ["idle", "capture", "input", "element"] as const) {
            const f = fixture();
            const entered = deferred<boolean>();
            const surfaceReady = deferred<ComputerConsentSurface>();
            const host = new ComputerLocalConsentHost(
                {
                    command: process.execPath,
                    args: ["--no-env-file", child],
                    cwd: directory,
                    environment: process.env as Record<string, string>,
                    windowsHide: true,
                    origin: "https://private.example.test",
                },
                (_target, stopped) => {
                    stopped.addEventListener(
                        "abort",
                        () => f.events.push("driver-aborted"),
                        { once: true }
                    );
                    return Promise.resolve(f.port);
                },
                async (options) => {
                    const surface = await openComputerConsentSurface(options);
                    surfaceReady.resolve(surface!);
                    return surface;
                }
            );
            const credential = issueComputerCredential(
                "device",
                f.request.computerId
            ).token;
            const companion = new ComputerCompanion(
                "https://private.example.test",
                (url, init) => {
                    const input = JSON.parse(init.body as string) as Record<
                        string,
                        unknown
                    >;
                    const route = url.pathname.split("/").at(-1)!;
                    f.events.push(route);
                    if (route === "pending")
                        return Promise.resolve(Response.json({ request: f.request }));
                    if (route === "accept") {
                        const { consentExpiresAt: _, ...summary } = f.request;
                        return Promise.resolve(
                            Response.json({ ...summary, state: "active" })
                        );
                    }
                    if (route === "permit")
                        return Promise.resolve(
                            Response.json({ ...input, validForMs: 5000 })
                        );
                    return Promise.resolve(Response.json({ stopped: true }));
                }
            );
            const controller = new ComputerConsentController({
                companion,
                credential,
                connectionId: crypto.randomUUID(),
                signal: f.stopped.signal,
                host,
            });
            try {
                expect(await controller.review()).toBe(true);
                const surface = await surfaceReady.promise;
                const observed = await controller.observe(signal());
                const inFlight =
                    deferred<Awaited<ReturnType<ComputerWindowPort["observe"]>>>();
                const inputFlight = deferred<{ effect: "confirmed" }>();
                let pending: Promise<unknown> | undefined;
                if (operation === "capture") {
                    f.port.observe = () => {
                        entered.resolve(true);
                        return inFlight.promise;
                    };
                    pending = controller.observe(signal());
                }
                if (operation === "input" || operation === "element") {
                    const pendingInput = () => {
                        entered.resolve(true);
                        return inputFlight.promise;
                    };
                    if (operation === "element") f.port.clickElement = pendingInput;
                    else f.port.type = pendingInput;
                    pending = controller.act(
                        operation === "element"
                            ? {
                                  action: "click_element",
                                  observationId: observed.observationId,
                                  elementToken: "s00000001:1",
                              }
                            : {
                                  action: "type",
                                  observationId: observed.observationId,
                                  text: "Synthetic",
                              },
                        signal()
                    );
                }
                if (pending) await entered.promise;
                // Terminate the real child: pipe loss must retire authority without waiting for another command.
                await surface.close();
                expect(host.signal.aborted).toBe(true);
                expect(f.events).toContain("driver-aborted");
                inputFlight.resolve({ effect: "confirmed" });
                inFlight.resolve({
                    snapshot: "late",
                    width: 390,
                    height: 110,
                    content: { content: observed.content },
                });
                if (operation === "capture") await rejects(pending!);
                if (operation === "input" || operation === "element")
                    expect(await pending).toEqual({ effect: "unknown" });
                await controller.close();
                await rejects(controller.observe(signal()));
                expect(
                    f.events.filter((event) => event === "driver-closed")
                ).toHaveLength(1);
                expect(f.events.indexOf("driver-closed")).toBeLessThan(
                    f.events.indexOf("stop")
                );
            } finally {
                await controller.close();
            }
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("local refusal retires the composed controller without acceptance or native startup", async () => {
    const f = fixture();
    f.factories.surface = () => Promise.resolve(null);
    const controller = new ComputerConsentController({
        companion: {
            pendingAccess: () => Promise.resolve(f.request),
            acceptAccess: () => {
                throw new Error("Acceptance must not run");
            },
            permitAccess: () => {
                throw new Error("Permit must not run");
            },
            stopAccess: () => {
                f.events.push("stop");
                return Promise.resolve();
            },
        },
        credential: "synthetic-unused",
        connectionId: crypto.randomUUID(),
        signal: f.stopped.signal,
        host: f.host,
    });
    try {
        expect(await controller.review()).toBe(false);
        expect(f.host.signal.aborted).toBe(true);
        expect(f.events).toEqual(["stop"]);
        await rejects(controller.review());
    } finally {
        await controller.close();
    }
});

test("unconfirmed supervisor cleanup during startup remains a failure on repeated host close", async () => {
    const { RuntimeCleanupError } = await import("../runtime/rpcProcess");
    for (const stage of ["surface", "driver"]) {
        const f = fixture();
        if (stage === "surface") {
            f.factories.surface = () => Promise.reject(new RuntimeCleanupError());
            await rejects(f.host.select(f.request, signal()), RuntimeCleanupError);
        } else {
            await f.host.select(f.request, signal());
            f.factories.driver = () => Promise.reject(new RuntimeCleanupError());
            await rejects(f.host.open(f.target, signal()), RuntimeCleanupError);
        }
        await rejects(f.host.close(), RuntimeCleanupError);
        await rejects(f.host.close(), RuntimeCleanupError);
        expect(f.host.signal.aborted).toBe(true);
    }
});

test("composed consent controller forwards observed element input and preserves view-only refusal", async () => {
    for (const mode of ["view", "control"] as const) {
        const f = fixture(mode);
        const { consentExpiresAt: _, ...receipt } = f.request;
        const controller = new ComputerConsentController({
            companion: {
                pendingAccess: () => Promise.resolve(f.request),
                acceptAccess: () =>
                    Promise.resolve({ ...receipt, state: "active" as const }),
                permitAccess: (_credential, binding) =>
                    Promise.resolve({ ...binding, validForMs: 5000 }),
                stopAccess: () => Promise.resolve(),
            },
            credential: "synthetic-unused",
            connectionId: crypto.randomUUID(),
            signal: f.stopped.signal,
            host: f.host,
        });
        try {
            expect(await controller.review()).toBe(true);
            const frame = await controller.observe(signal());
            const input = {
                action: "click_element",
                observationId: frame.observationId,
                elementToken: "s00000001:1",
            };
            if (mode === "view") {
                await rejects(controller.act(input, signal()), /view-only/);
                expect(f.events).not.toContain("element");
            } else {
                expect(await controller.act(input, signal())).toEqual({
                    effect: "confirmed",
                });
                expect(f.events.filter((event) => event === "element")).toHaveLength(1);
                await rejects(controller.act(input, signal()), /fresh/);
            }
        } finally {
            await controller.close();
        }
        expect(f.events.filter((event) => event === "driver-closed")).toHaveLength(1);
    }
});
