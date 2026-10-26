import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import path from "node:path";

import { RuntimeCleanupError } from "../runtime/rpcProcess";
import { ComputerCompanion, ComputerConnectionError } from "./companion";
import type { ComputerConsentHost } from "./companionConsent";
import { runComputerConsentLoop } from "./companionLifecycle";
import { runComputerPresence } from "./companionPresence";
import { issueComputerCredential } from "./credentials";
import type { ComputerWindowGrant } from "./policy";

const deferred = <T>() => Promise.withResolvers<T>();
function abortable(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
    );
}
async function until(check: () => boolean) {
    for (let i = 0; i < 1000; i++) {
        if (check()) return;
        await Bun.sleep(1);
    }
    throw new Error("Fixture transition did not complete.");
}
function fixture() {
    const computerId = crypto.randomUUID();
    const credential = issueComputerCredential("device", computerId).token;
    const stop = new AbortController();
    const request = {
        id: crypto.randomUUID(),
        computerId,
        runId: crypto.randomUUID(),
        mode: "control" as const,
        state: "pending" as const,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        consentExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const events: string[] = [];
    const generationIds: string[] = [];
    const behavior = {
        connect: () => {},
        heartbeat: () => 200,
        pending: () => request,
        stop: () => 200,
    };
    const client = new ComputerCompanion("https://private.example.test", (url, init) => {
        const route = url.pathname.split("/").at(-1)!;
        events.push(route);
        const body = JSON.parse(
            typeof init.body === "string" ? init.body : "null"
        ) as Record<string, unknown>;
        if (route === "connect") {
            const connectionId = crypto.randomUUID();
            generationIds.push(connectionId);
            behavior.connect();
            return Promise.resolve(
                Response.json({
                    connectionId,
                    heartbeatSeconds: 15,
                    leaseSeconds: 45,
                    controlAllowed: false,
                })
            );
        }
        if (route === "heartbeat") {
            const status = behavior.heartbeat();
            return Promise.resolve(
                status === 200
                    ? Response.json({ leaseSeconds: 45, controlAllowed: false })
                    : new Response(null, { status })
            );
        }
        if (route === "pending")
            return Promise.resolve(Response.json({ request: behavior.pending() }));
        if (route === "accept") {
            const { consentExpiresAt: _deadline, ...summary } = request;
            return Promise.resolve(Response.json({ ...summary, state: "active" }));
        }
        if (route === "permit")
            return Promise.resolve(Response.json({ ...body, validForMs: 5000 }));
        const status = behavior.stop();
        return Promise.resolve(
            status === 200
                ? Response.json({ stopped: true })
                : new Response(null, { status })
        );
    });
    const target: ComputerWindowGrant = {
        executable: path.resolve("fixture"),
        pid: 123,
        windowId: "456",
        delivery: "foreground",
        mode: "control",
    };
    function host() {
        const local = new AbortController();
        const value: ComputerConsentHost = {
            signal: local.signal,
            select: () => {
                events.push("prompt");
                return Promise.resolve(target);
            },
            assertReady: () => Promise.resolve(),
            open: () => {
                events.push("open");
                return Promise.resolve({
                    observe: () => Promise.reject(new Error("No fixture capture")),
                    click: () => Promise.reject(new Error("No fixture input")),
                    type: () => Promise.reject(new Error("No fixture input")),
                    close: () => {
                        events.push("driver-closed");
                        return Promise.resolve();
                    },
                });
            },
            close: () => {
                events.push("host-closed");
                local.abort();
                return Promise.resolve();
            },
        };
        return { value, local };
    }
    const presence = {
        companion: client,
        credential,
        expiresAt: request.expiresAt,
        signal: stop.signal,
        status: (state: string) => {
            events.push(state);
        },
    };
    return {
        client,
        credential,
        request,
        stop,
        events,
        generationIds,
        behavior,
        host,
        target,
        presence,
    };
}

test("heartbeats continue during local consent and reconnect waits for late selection and cleanup", async () => {
    const f = fixture();
    const prompted = deferred<void>(),
        choice = deferred<ComputerWindowGrant | null>();
    const cleanup = deferred<void>();
    let beats = 0,
        cleanupStarted = false,
        retired = false;
    f.behavior.heartbeat = () => (++beats === 2 ? 503 : 200);
    f.behavior.connect = () => {
        if (f.generationIds.length === 2) f.stop.abort();
    };
    const run = runComputerPresence({
        ...f.presence,
        wait: (ms) => (ms === 15_000 ? prompted.promise : Promise.resolve()),
        connectionWork: ({ connectionId, signal }) =>
            runComputerConsentLoop({
                companion: f.client,
                credential: f.credential,
                connectionId,
                signal,
                createHost: () => {
                    const h = f.host();
                    h.value.select = (_request, stopped) => {
                        stopped.addEventListener(
                            "abort",
                            () => {
                                retired = true;
                            },
                            { once: true }
                        );
                        prompted.resolve();
                        return choice.promise;
                    };
                    h.value.close = () => {
                        cleanupStarted = true;
                        return cleanup.promise;
                    };
                    return h.value;
                },
                runSession: () => Promise.reject(new Error("Must not open")),
            }),
    });
    await until(() => cleanupStarted);
    expect(beats).toBe(2);
    expect(retired).toBe(true);
    expect(f.generationIds).toHaveLength(1);
    choice.resolve(f.target);
    await Bun.sleep(1);
    expect(f.generationIds).toHaveLength(1);
    cleanup.resolve();
    await run;
    expect(f.generationIds).toHaveLength(2);
    expect(f.generationIds[0]).not.toBe(f.generationIds[1]);
    expect(f.events).not.toContain("accept");
    expect(f.events).not.toContain("open");
    expect(f.events).toContain("reconnecting");
});

test("declined request IDs never prompt twice even if stop delivery fails, while a fresh request can prompt", async () => {
    const f = fixture();
    let polls = 0,
        prompts = 0;
    const newId = crypto.randomUUID();
    f.behavior.pending = () => {
        if (++polls === 4) f.request.id = newId;
        return f.request;
    };
    f.behavior.stop = () => 503;
    await runComputerConsentLoop({
        companion: f.client,
        credential: f.credential,
        connectionId: crypto.randomUUID(),
        signal: f.stop.signal,
        createHost: () => {
            const h = f.host();
            h.value.select = () => {
                prompts++;
                return Promise.resolve(null);
            };
            return h.value;
        },
        runSession: () => Promise.reject(new Error("Declined")),
        wait: () => {
            if (prompts === 2) f.stop.abort();
            return Promise.resolve();
        },
    });
    expect(prompts).toBe(2);
    expect(polls).toBe(4);
    expect(f.events.filter((e) => e === "stop")).toHaveLength(2);
    expect(f.events).not.toContain("accept");
});

test("local retirement waits for accepted work and cleanup before creating another consent host", async () => {
    const f = fixture();
    const active = deferred<void>(),
        releaseWork = deferred<void>(),
        releaseCleanup = deferred<void>();
    const h = f.host();
    let hosts = 0,
        closed = false;
    h.value.close = () => {
        closed = true;
        h.local.abort();
        return releaseCleanup.promise;
    };
    const run = runComputerConsentLoop({
        companion: f.client,
        credential: f.credential,
        connectionId: crypto.randomUUID(),
        signal: f.stop.signal,
        createHost: () => {
            hosts++;
            return h.value;
        },
        runSession: async (_controller, signal) => {
            active.resolve();
            await abortable(signal);
            await releaseWork.promise;
        },
        wait: () => {
            f.stop.abort();
            return Promise.resolve();
        },
    });
    await active.promise;
    expect(f.events.indexOf("accept")).toBeLessThan(f.events.indexOf("open"));
    h.local.abort();
    await until(() => closed);
    expect(hosts).toBe(1);
    releaseCleanup.resolve();
    await Bun.sleep(1);
    expect(hosts).toBe(1);
    releaseWork.resolve();
    await run;
    expect(hosts).toBe(1);
    expect(f.events.filter((e) => e === "driver-closed")).toHaveLength(1);
});

test("unconfirmed cleanup remains terminal after both local stop and a retryable heartbeat failure", async () => {
    for (const kind of ["local", "network"]) {
        const f = fixture();
        const active = deferred<void>();
        f.behavior.heartbeat = () => 503;
        const run = runComputerPresence({
            ...f.presence,
            wait: async (ms) => {
                expect(ms).toBe(15_000);
                await active.promise;
                if (kind === "local") f.stop.abort();
            },
            connectionWork: ({ connectionId, signal }) =>
                runComputerConsentLoop({
                    companion: f.client,
                    credential: f.credential,
                    connectionId,
                    signal,
                    createHost: () => {
                        const h = f.host();
                        h.value.close = () =>
                            Promise.reject(new Error("Unconfirmed native cleanup"));
                        return h.value;
                    },
                    runSession: async (_controller, stopped) => {
                        active.resolve();
                        await abortable(stopped);
                    },
                }),
        });
        await rejects(run, RuntimeCleanupError);
        expect(f.generationIds).toHaveLength(1);
        expect(f.events).not.toContain("reconnecting");
    }
});

test("a connection-work failure aborts an idle heartbeat before retrying and never resumes its generation", async () => {
    const f = fixture();
    let work = 0,
        heartbeatStopped = false;
    await runComputerPresence({
        ...f.presence,
        wait: async (ms, signal) => {
            if (ms === 30_000) {
                expect(heartbeatStopped).toBe(true);
                f.stop.abort();
                return;
            }
            await abortable(signal);
            heartbeatStopped = true;
            signal.throwIfAborted();
        },
        connectionWork: () => {
            work++;
            return Promise.reject(new ComputerConnectionError(true));
        },
    });
    expect(work).toBe(1);
    expect(f.generationIds).toHaveLength(1);
    expect(f.events).toContain("reconnecting");
});

test("a connection task ending unexpectedly is terminal and its teardown failure cannot be hidden by an outage", async () => {
    for (const kind of ["completed", "cleanup"]) {
        const f = fixture();
        const ready = deferred<void>();
        f.behavior.heartbeat = () => 503;
        const run = runComputerPresence({
            ...f.presence,
            wait: async (_ms, signal) => {
                if (kind === "cleanup") await ready.promise;
                else {
                    await abortable(signal);
                    signal.throwIfAborted();
                }
            },
            connectionWork: async ({ signal }) => {
                if (kind === "completed") return;
                ready.resolve();
                await abortable(signal);
                throw new Error("Local teardown failed");
            },
        });
        await rejects(
            run,
            kind === "cleanup" ? RuntimeCleanupError : /ended unexpectedly/
        );
        expect(f.generationIds).toHaveLength(1);
        expect(f.events).not.toContain("reconnecting");
    }
});

test("a failed native startup with unconfirmed cleanup cannot be treated as a declined consent", async () => {
    const f = fixture();
    let hosts = 0;
    await rejects(
        runComputerConsentLoop({
            companion: f.client,
            credential: f.credential,
            connectionId: crypto.randomUUID(),
            signal: f.stop.signal,
            createHost: () => {
                hosts++;
                const h = f.host();
                h.value.open = () => Promise.reject(new RuntimeCleanupError());
                return h.value;
            },
            runSession: () => Promise.reject(new Error("Never active")),
        }),
        RuntimeCleanupError
    );
    expect(hosts).toBe(1);
});

test("local shutdown cannot hide an unconfirmed connection task cleanup even when that task fails first", async () => {
    const f = fixture();
    const heartbeat = deferred<void>();
    const run = runComputerPresence({
        ...f.presence,
        wait: () => heartbeat.promise,
        connectionWork: () => {
            f.stop.abort();
            return Promise.reject(new Error("Cleanup could not be confirmed"));
        },
    });
    await until(() => f.stop.signal.aborted);
    await Bun.sleep(1);
    heartbeat.resolve();
    await rejects(run, RuntimeCleanupError);
    expect(f.generationIds).toHaveLength(1);
    expect(f.events).not.toContain("reconnecting");
});
