import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import path from "node:path";

import { createVisualChallenge } from "../testing/visualChallenge";
import { ComputerCompanion, ComputerConnectionError } from "./companion";
import { ComputerConsentController, type ComputerConsentHost } from "./companionConsent";
import { issueComputerCredential } from "./credentials";
import type { ComputerWindowGrant } from "./policy";
import type { ComputerWindowPort } from "./session";

const signal = () => new AbortController().signal;
function summaryOf(request: {
    id: string;
    computerId: string;
    runId: string;
    mode: "view" | "control";
    state: string;
    expiresAt: string;
}) {
    return {
        id: request.id,
        computerId: request.computerId,
        runId: request.runId,
        mode: request.mode,
        state: request.state,
        expiresAt: request.expiresAt,
    };
}
function deferred<T>() {
    let complete!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        complete = resolve;
    });
    return { promise, resolve: complete };
}
function fixture(mode: "view" | "control" = "control") {
    const id = crypto.randomUUID();
    const credential = issueComputerCredential("device", id).token;
    const connectionId = crypto.randomUUID();
    const summary = {
        id: crypto.randomUUID(),
        computerId: id,
        runId: crypto.randomUUID(),
        mode,
        state: "pending" as const,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    const request = {
        ...summary,
        consentExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const target: ComputerWindowGrant = {
        executable: path.resolve("synthetic-window"),
        pid: 123,
        windowId: "456",
        delivery: "foreground",
    };
    const events: string[] = [];
    const bodies: unknown[] = [];
    const stopped = new AbortController();
    const localStop = new AbortController();
    let clock = 100;
    let available = true;
    let pending = true;
    let lease = 5000;
    let accepted: Record<string, unknown> | undefined;
    const response = (route: string, input: Record<string, unknown>): unknown => {
        if (route === "pending") return { request: pending ? request : null };
        if (route === "accept") {
            accepted = input;
            return { ...summary, state: "active" };
        }
        if (route === "permit") {
            if (!available) throw new Error("offline");
            return { ...input, mode, validForMs: lease };
        }
        return { stopped: true };
    };
    const responder = { response };
    const client = new ComputerCompanion("https://private.example.test", (url, init) => {
        const route = url.pathname.split("/").at(-1)!;
        events.push(route);
        expect(new Headers(init.headers).get("authorization")).toBe(
            `Bearer ${credential}`
        );
        expect(url.origin).toBe("https://private.example.test");
        expect(init.redirect).toBe("error");
        const input = JSON.parse(
            typeof init.body === "string" ? init.body : "null"
        ) as Record<string, unknown>;
        bodies.push(input);
        return Promise.resolve(Response.json(responder.response(route, input)));
    });
    const port: ComputerWindowPort = {
        observe: () => {
            events.push("observe");
            return Promise.resolve({
                snapshot: "fixture",
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
            });
        },
        clickElement: () => Promise.resolve({ effect: "refused" as const }),
        click: () => {
            events.push("click");
            return Promise.resolve({ effect: "confirmed" });
        },
        type: () => {
            events.push("type");
            return Promise.resolve({ effect: "confirmed" });
        },
        close: () => {
            events.push("closed");
            return Promise.resolve();
        },
    };
    const host: ComputerConsentHost = {
        signal: localStop.signal,
        close: () => {
            events.push("host-closed");
            return Promise.resolve();
        },
        select: (shown) => {
            expect(shown).toEqual(request);
            events.push("prompt");
            return Promise.resolve(target);
        },
        assertReady: () => {
            events.push("ready");
            return Promise.resolve();
        },
        open: (selected) => {
            events.push("open");
            expect(selected).toEqual({ ...target, mode });
            expect(Object.isFrozen(selected)).toBe(true);
            return Promise.resolve(port);
        },
    };
    const controller = new ComputerConsentController({
        companion: client,
        credential,
        connectionId,
        signal: stopped.signal,
        host,
        now: () => clock,
    });
    return {
        controller,
        client,
        credential,
        connectionId,
        request,
        target,
        events,
        bodies,
        stopped,
        localStop,
        host,
        port,
        responder,
        accepted: () => accepted,
        unavailable: () => {
            available = false;
        },
        pending: (value: boolean) => {
            pending = value;
        },
        advance: (ms: number) => {
            clock += ms;
        },
        lease: (ms: number) => {
            lease = ms;
        },
    };
}

test("local consent precedes acceptance and native startup; only opaque target identities leave the PC", async () => {
    const f = fixture();
    const choice = deferred<ComputerWindowGrant | null>();
    f.host.select = () => choice.promise;
    try {
        const review = f.controller.review();
        await Bun.sleep(1);
        expect(f.events).toEqual(["pending"]);
        await rejects(f.controller.observe(signal()), /awaiting local consent/);
        // A premature command permanently retires this attempt; no late approval may resurrect it.
        choice.resolve(f.target);
        await rejects(review);
        expect(f.events).not.toContain("accept");
        expect(f.events).not.toContain("open");
    } finally {
        await f.controller.close();
    }
    const g = fixture();
    try {
        expect(await g.controller.review()).toBe(true);
        expect(g.events.indexOf("prompt")).toBeLessThan(g.events.indexOf("accept"));
        expect(g.events.indexOf("accept")).toBeLessThan(g.events.indexOf("open"));
        expect(g.accepted()).toMatchObject({
            id: g.request.id,
            connectionId: g.connectionId,
        });
        expect(g.accepted()?.targetId).toMatch(/^[a-f0-9-]{36}$/);
        expect(JSON.stringify(g.bodies)).not.toContain(g.target.executable);
        expect(JSON.stringify(g.bodies)).not.toContain('"pid"');
        const frame = await g.controller.observe(signal());
        expect(
            await g.controller.act(
                { action: "type", observationId: frame.observationId, text: "Synthetic" },
                signal()
            )
        ).toEqual({ effect: "confirmed" });
        expect(g.events.filter((event) => event === "type")).toHaveLength(1);
    } finally {
        await g.controller.close();
    }
    expect(g.events.indexOf("closed")).toBeLessThan(g.events.indexOf("stop"));
});

test("no request, rejection, late local selection and concurrent prompts cannot grant access", async () => {
    const f = fixture();
    try {
        f.pending(false);
        expect(await f.controller.review()).toBe(false);
        expect(f.events).toEqual(["pending"]);
        f.pending(true);
        const choice = deferred<ComputerWindowGrant | null>();
        f.host.select = () => choice.promise;
        const review = f.controller.review();
        await Bun.sleep(1);
        await rejects(f.controller.review(), /already requested/);
        f.stopped.abort();
        choice.resolve(f.target);
        await rejects(review);
        expect(f.events).not.toContain("accept");
        expect(f.events).not.toContain("open");
    } finally {
        await f.controller.close();
    }
    const g = fixture();
    g.host.select = () => Promise.resolve(null);
    expect(await g.controller.review()).toBe(false);
    expect(g.events).toEqual(["pending", "host-closed", "stop"]);
    await rejects(g.controller.review());
    await g.controller.close();
});

test("view-only consent can observe but never invoke native input or widen the local manifest", async () => {
    const f = fixture("view");
    f.target.mode = "control";
    try {
        expect(await f.controller.review()).toBe(true);
        const frame = await f.controller.observe(signal());
        await rejects(
            f.controller.act(
                { action: "click", observationId: frame.observationId, x: 1, y: 1 },
                signal()
            ),
            /view-only/
        );
        expect(f.events).not.toContain("click");
        expect(f.events).not.toContain("type");
    } finally {
        await f.controller.close();
    }
});

test("OS readiness, in-transit expiry, clock reversal and uncertain acceptance all prevent native startup", async () => {
    for (const failure of ["locked", "transit", "clock", "accept", "receipt"]) {
        const f = fixture();
        const original = f.responder.response;
        if (failure === "locked")
            f.host.assertReady = () => Promise.reject(new Error("locked"));
        f.responder.response = (route, input) => {
            if (route === "permit" && failure === "transit") f.advance(5001);
            if (route === "permit" && failure === "clock") f.advance(-1);
            if (route === "accept" && failure === "accept")
                throw new Error("lost receipt");
            if (route === "accept" && failure === "receipt")
                return {
                    ...summaryOf(f.request),
                    state: "active",
                    runId: crypto.randomUUID(),
                };
            return original(route, input);
        };
        try {
            await rejects(f.controller.review());
            expect(f.events).not.toContain("open");
            expect(
                f.events.filter((event) => event === "accept").length
            ).toBeLessThanOrEqual(1);
            await rejects(f.controller.review());
        } finally {
            await f.controller.close();
        }
    }
});

test("stop waits for a late starting native child to close and never reopens it", async () => {
    const f = fixture();
    const opening = deferred<ComputerWindowPort>();
    const entered = deferred<boolean>();
    f.host.open = (_target, stopped) => {
        entered.resolve(true);
        stopped.addEventListener("abort", () => f.events.push("aborted"), { once: true });
        return opening.promise;
    };
    const review = f.controller.review();
    await entered.promise;
    const closing = f.controller.close();
    expect(f.events).toContain("aborted");
    expect(f.events).not.toContain("stop");
    opening.resolve(f.port);
    await rejects(review);
    await closing;
    await f.controller.close();
    expect(f.events.filter((event) => event === "closed")).toHaveLength(1);
    expect(f.events.indexOf("closed")).toBeLessThan(f.events.indexOf("stop"));
});

test("connection loss and changed readiness retire live access before further input", async () => {
    for (const failure of ["connection", "local-stop", "server", "locked", "budget"]) {
        const f = fixture();
        try {
            await f.controller.review();
            const frame = await f.controller.observe(signal());
            if (failure === "connection") f.stopped.abort();
            if (failure === "local-stop") f.localStop.abort();
            if (failure === "server") f.unavailable();
            if (failure === "locked")
                f.host.assertReady = () => Promise.reject(new Error("locked"));
            if (failure === "budget") f.advance(300_001);
            await rejects(
                f.controller.act(
                    {
                        action: "type",
                        observationId: frame.observationId,
                        text: "Never delivered",
                    },
                    signal()
                )
            );
            expect(f.events).not.toContain("type");
        } finally {
            await f.controller.close();
        }
        expect(f.events.filter((event) => event === "closed")).toHaveLength(1);
    }
});

test("interruption after input dispatch preserves unknown, discards late captures and never retries", async () => {
    for (const kind of ["input", "capture"]) {
        const f = fixture();
        try {
            await f.controller.review();
            const frame = await f.controller.observe(signal());
            if (kind === "input") {
                f.port.type = () => {
                    f.events.push("type");
                    f.stopped.abort();
                    return Promise.resolve({ effect: "confirmed" });
                };
                expect(
                    await f.controller.act(
                        {
                            action: "type",
                            observationId: frame.observationId,
                            text: "Maybe delivered",
                        },
                        signal()
                    )
                ).toEqual({ effect: "unknown" });
                expect(f.events.filter((event) => event === "type")).toHaveLength(1);
            } else {
                const original = f.port.observe;
                f.port.observe = async (s) => {
                    const result = await original(s);
                    f.unavailable();
                    return result;
                };
                await rejects(f.controller.observe(signal()));
            }
            await rejects(f.controller.observe(signal()));
        } finally {
            await f.controller.close();
        }
    }
});

test("a stalled renewal is cut off by the last short permit while an idle driver is open", async () => {
    const f = fixture();
    f.lease(80);
    const original = f.client.permitAccess.bind(f.client);
    let calls = 0;
    let aborted = false;
    f.client.permitAccess = (token, input, stopped) => {
        if (++calls <= 2) return original(token, input, stopped);
        return new Promise((_resolve, reject) => {
            stopped.addEventListener(
                "abort",
                () => {
                    aborted = true;
                    reject(new Error("aborted"));
                },
                { once: true }
            );
        });
    };
    try {
        await f.controller.review();
        await Bun.sleep(120);
        expect(f.events).toContain("closed");
        expect(aborted).toBe(true);
        await rejects(f.controller.observe(signal()));
    } finally {
        await f.controller.close();
    }
});

test("consent receipts reject mismatched devices, identities, scopes, overlong permits and extra commands", async () => {
    const f = fixture();
    const input = {
        id: f.request.id,
        connectionId: f.connectionId,
        targetId: crypto.randomUUID(),
        mode: "control" as const,
    };
    for (const change of [
        { id: crypto.randomUUID() },
        { connectionId: crypto.randomUUID() },
        { targetId: crypto.randomUUID() },
        { mode: "view" },
        { validForMs: 5001 },
        { validForMs: 0 },
        { command: "click" },
    ]) {
        f.responder.response = () => ({ ...input, validForMs: 5000, ...change });
        await rejects(
            f.client.permitAccess(f.credential, input, signal()),
            ComputerConnectionError
        );
    }
    for (const change of [
        { computerId: crypto.randomUUID() },
        { state: "active" },
        { expiresAt: "2000-01-01T00:00:00.000Z" },
        { executable: "/bad" },
    ]) {
        f.responder.response = () => ({ request: { ...f.request, ...change } });
        await rejects(
            f.client.pendingAccess(f.credential, f.connectionId, signal()),
            ComputerConnectionError
        );
    }
    f.responder.response = () => ({ stopped: false });
    await rejects(
        f.client.stopAccess(f.credential, f.request.id, signal()),
        ComputerConnectionError
    );
    await rejects(
        f.client.permitAccess("invalid", input, signal()),
        ComputerConnectionError
    );
    await rejects(
        f.client.pendingAccess(f.credential, "invalid", signal()),
        ComputerConnectionError
    );
    await rejects(
        f.client.acceptAccess(
            "invalid",
            { ...input, mode: undefined } as never,
            signal()
        ),
        ComputerConnectionError
    );
    await rejects(
        f.client.stopAccess("invalid", f.request.id, signal()),
        ComputerConnectionError
    );
    await f.controller.close();
});

test("a late-discovered prompt preserves its original consent deadline and never sends a late acceptance", async () => {
    const f = fixture();
    const prompted = deferred<boolean>();
    const expired = deferred<boolean>();
    const selected = deferred<ComputerWindowGrant | null>();
    f.request.consentExpiresAt = new Date(Date.now() + 100).toISOString();
    f.host.select = (_request, stopped) => {
        stopped.addEventListener("abort", () => expired.resolve(true), { once: true });
        prompted.resolve(true);
        return selected.promise;
    };
    const review = f.controller.review();
    try {
        await prompted.promise;
        await expired.promise;
        selected.resolve(f.target);
        await rejects(review);
        expect(f.events).not.toContain("accept");
        expect(f.events).not.toContain("open");
    } finally {
        selected.resolve(null);
        await f.controller.close();
    }
    const g = fixture();
    g.request.consentExpiresAt = new Date(Date.now() + 1000).toISOString();
    g.host.select = () => {
        g.advance(1001);
        return Promise.resolve(g.target);
    };
    await rejects(g.controller.review(), /consent expired/);
    expect(g.events).not.toContain("accept");
    await g.controller.close();
});

test("controller cleanup waits for the consent host even before driver startup and preserves failures", async () => {
    for (const stage of ["pending", "active"]) {
        const f = fixture();
        const reaped = deferred<boolean>();
        f.host.close = async () => {
            f.events.push("host-closing");
            await reaped.promise;
            throw new Error("surface still running");
        };
        if (stage === "active") await f.controller.review();
        const closing = f.controller.close();
        const failed = rejects(closing, /surface still running/);
        expect(f.controller.close()).toBe(closing);
        await Bun.sleep(1);
        expect(f.events).toContain("host-closing");
        expect(f.events).not.toContain("stop");
        reaped.resolve(true);
        await failed;
        await rejects(f.controller.close(), /surface still running/);
        await rejects(f.controller.review());
        if (stage === "active") expect(f.events).toContain("closed");
    }
});
