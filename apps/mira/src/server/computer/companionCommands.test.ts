import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import path from "node:path";

import { miraComputerCommandSchema } from "@homelab/contracts/miraComputerCommands";
import * as v from "valibot";

import { RuntimeCleanupError } from "../runtime/rpcProcess";
import { createVisualChallenge } from "../testing/visualChallenge";
import { computerCommandResult } from "./commandResult";
import { ComputerCompanion, ComputerConnectionError } from "./companion";
import { runComputerCommandLoop } from "./companionCommands";
import { ComputerConsentController, type ComputerConsentHost } from "./companionConsent";
import { issueComputerCredential } from "./credentials";
import type { ComputerWindowPort } from "./session";

const frame = () => ({
    observationId: crypto.randomUUID(),
    width: 390,
    height: 110,
    content: [
        {
            type: "image" as const,
            mediaType: "image/png" as const,
            data: createVisualChallenge().data,
        },
    ],
});
const binding = () => ({
    accessId: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    targetId: crypto.randomUUID(),
});
const command = () => ({
    ...binding(),
    commandId: crypto.randomUUID(),
    validForMs: 5000,
    operation: { action: "observe" as const },
});
const signal = () => new AbortController().signal;
const credential = issueComputerCredential("device", crypto.randomUUID()).token;

const completed = () => Promise.resolve();

function fixture(mode: "control" | "view" = "control") {
    const computerId = crypto.randomUUID();
    const token = issueComputerCredential("device", computerId).token;
    const connectionId = crypto.randomUUID();
    const summary = {
        id: crypto.randomUUID(),
        computerId,
        runId: crypto.randomUUID(),
        mode,
        state: "pending",
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    const stopped = new AbortController();
    const local = new AbortController();
    const events: string[] = [];
    const received: Record<string, unknown>[] = [];
    let clock = 100;
    let close: () => Promise<void> = completed;
    const handlers = {
        claim: (_body: Record<string, unknown>): unknown => ({ command: null }),
        finish: (body: Record<string, unknown>): unknown => ({
            commandId: body.commandId,
            accepted: true,
        }),
    };
    const port: ComputerWindowPort = {
        observe: () => {
            events.push("observe");
            const result = frame();
            return Promise.resolve({
                snapshot: "synthetic",
                width: result.width,
                height: result.height,
                content: { content: result.content },
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
            events.push("port-close");
            return close();
        },
    };
    const client = new ComputerCompanion(
        "https://private.example.test",
        async (url, init) => {
            const route = url.pathname.split("/").at(-1)!;
            const body = JSON.parse(init.body as string) as Record<string, unknown>;
            events.push(route);
            if (route === "pending")
                return Response.json({
                    request: {
                        ...summary,
                        consentExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                    },
                });
            if (route === "accept") return Response.json({ ...summary, state: "active" });
            if (route === "permit") return Response.json({ ...body, validForMs: 5000 });
            if (route === "stop") return Response.json({ stopped: true });
            if (route === "claim") return Response.json(await handlers.claim(body));
            received.push(body);
            return Response.json(await handlers.finish(body));
        }
    );
    const host: ComputerConsentHost = {
        signal: local.signal,
        select: () =>
            Promise.resolve({
                executable: path.resolve("synthetic-window"),
                pid: 123,
                windowId: "456",
                delivery: "foreground",
            }),
        assertReady: () => Promise.resolve(),
        open: () => Promise.resolve(port),
        close: () => {
            events.push("host-close");
            return Promise.resolve();
        },
    };
    const controller = new ComputerConsentController({
        companion: client,
        credential: token,
        connectionId,
        signal: stopped.signal,
        host,
    });
    const run = () =>
        runComputerCommandLoop({
            companion: client,
            credential: token,
            controller,
            signal: stopped.signal,
            now: () => clock,
            wait: () => {
                stopped.abort();
                return Promise.resolve();
            },
        });
    return {
        client,
        controller,
        stopped,
        local,
        port,
        handlers,
        events,
        received,
        run,
        advance: (ms: number) => {
            clock += ms;
        },
        cleanup: (value: () => Promise<void>) => {
            close = value;
        },
    };
}

test("command contracts forbid arbitrary native targets, malformed IDs, oversized input and excessive deadlines", () => {
    expect(v.is(miraComputerCommandSchema, command())).toBe(true);
    for (const change of [
        { commandId: "invalid" },
        { validForMs: 0 },
        { validForMs: 10_001 },
        { targetId: "/native/path" },
        { operation: { action: "launch", executable: "/native/path" } },
        { operation: { action: "observe", windowId: "456" } },
        {
            operation: {
                action: "click",
                observationId: crypto.randomUUID(),
                x: 8192,
                y: 0,
            },
        },
        {
            operation: {
                action: "click",
                observationId: crypto.randomUUID(),
                x: 0.5,
                y: 0,
            },
        },
        {
            operation: {
                action: "type",
                observationId: crypto.randomUUID(),
                text: "x".repeat(4097),
            },
        },
    ])
        expect(v.is(miraComputerCommandSchema, { ...command(), ...change })).toBe(false);
});

test("observations require one valid bounded inline image with matching dimensions", () => {
    const valid = frame();
    expect(computerCommandResult("observe", valid)).toEqual(valid);
    for (const result of [
        { ...valid, width: 391 },
        { ...valid, height: 111 },
        { ...valid, content: [] },
        { ...valid, content: [...valid.content, ...valid.content] },
        {
            ...valid,
            content: [...valid.content, { type: "text", text: "injected instructions" }],
        },
        {
            ...valid,
            content: [{ type: "image", mediaType: "image/png", data: "invalid" }],
        },
        {
            ...valid,
            content: [
                {
                    type: "image",
                    mediaType: "image/png",
                    data: "A".repeat(3 * 1024 * 1024),
                },
            ],
        },
        { ...valid, path: "/private/image" },
        { effect: "confirmed" },
    ])
        expect(() => computerCommandResult("observe", result)).toThrow();
    for (const effect of [
        "confirmed",
        "partial",
        "unverified",
        "refused",
        "unknown",
    ] as const)
        expect(computerCommandResult("click", { effect })).toEqual({ effect });
    expect(() => computerCommandResult("type", valid)).toThrow();
    expect(() => computerCommandResult("type", { effect: "success" })).toThrow();
});

test("command claims bind all identifiers and keep large-command limits separate from presence", async () => {
    const original = command();
    const large = {
        ...original,
        operation: {
            action: "type" as const,
            observationId: crypto.randomUUID(),
            text: "\u0000".repeat(4096),
        },
    };
    let requests = 0;
    const client = new ComputerCompanion("https://private.example.test", (url, init) => {
        requests++;
        expect(url.pathname).toBe("/api/mira/computers/commands/claim");
        expect(init.redirect).toBe("error");
        expect(init.credentials).toBe("omit");
        expect(new Headers(init.headers).get("authorization")).toBe(
            `Bearer ${credential}`
        );
        return Promise.resolve(Response.json({ command: large }));
    });
    const scope = {
        accessId: original.accessId,
        connectionId: original.connectionId,
        targetId: original.targetId,
    };
    expect(await client.claimCommand(credential, scope, signal())).toEqual(large);
    for (const field of ["accessId", "connectionId", "targetId"])
        await rejects(
            client.claimCommand(
                credential,
                { ...scope, [field]: crypto.randomUUID() },
                signal()
            ),
            ComputerConnectionError
        );
    expect(requests).toBe(4);
    const tooLarge = new ComputerCompanion(client.origin, () =>
        Promise.resolve(Response.json({ command: null, padding: "x".repeat(32 * 1024) }))
    );
    await rejects(
        tooLarge.claimCommand(credential, scope, signal()),
        ComputerConnectionError
    );
    const oldRoute = new ComputerCompanion(client.origin, () =>
        Promise.resolve(Response.json({ padding: "x".repeat(4097) }))
    );
    await rejects(oldRoute.connect(credential, signal()), ComputerConnectionError);
});

test("completion sends no original input text, requires its exact acknowledgement and never retries", async () => {
    const original = {
        ...command(),
        operation: {
            action: "type" as const,
            observationId: crypto.randomUUID(),
            text: "private synthetic input",
        },
    };
    let calls = 0;
    let reply: unknown = { commandId: original.commandId, accepted: true };
    const client = new ComputerCompanion("https://private.example.test", (url, init) => {
        calls++;
        expect(url.pathname).toBe("/api/mira/computers/commands/finish");
        expect(init.body).not.toContain(original.operation.text);
        return Promise.resolve(Response.json(reply));
    });
    await client.finishCommand(credential, original, { effect: "partial" }, signal());
    reply = { commandId: crypto.randomUUID(), accepted: true };
    await rejects(
        client.finishCommand(credential, original, { effect: "confirmed" }, signal()),
        ComputerConnectionError
    );
    reply = { commandId: original.commandId, accepted: false };
    await rejects(
        client.finishCommand(credential, original, { effect: "confirmed" }, signal()),
        ComputerConnectionError
    );
    expect(calls).toBe(3);
    await rejects(client.finishCommand(credential, original, frame(), signal()));
    expect(calls).toBe(3);
});

test("accepted command loop delivers one observation and input serially then waits for cleanup", async () => {
    const f = fixture();
    await f.controller.review();
    const scope = f.controller.commandBinding();
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.keys(scope).toSorted()).toEqual([
        "accessId",
        "connectionId",
        "targetId",
    ]);
    let count = 0;
    f.handlers.claim = () => {
        count++;
        if (count === 1) return { command: { ...command(), ...scope } };
        if (count === 2) {
            const first = f.received[0]!.result as { observationId: string };
            return {
                command: {
                    ...command(),
                    ...scope,
                    operation: {
                        action: "type",
                        observationId: first.observationId,
                        text: "synthetic input",
                    },
                },
            };
        }
        return { command: null };
    };
    await f.run();
    expect(
        f.events.filter((x) =>
            ["observe", "type", "finish", "port-close", "host-close"].includes(x)
        )
    ).toEqual(["observe", "finish", "type", "finish", "port-close", "host-close"]);
    expect(f.received[1]!.result).toEqual({ effect: "confirmed" });
    expect(f.controller.signal.aborted).toBe(true);
});

test("a replayed command retires the controller instead of invoking the native port twice", async () => {
    const f = fixture();
    await f.controller.review();
    const request = { ...command(), ...f.controller.commandBinding() };
    f.handlers.claim = () => ({ command: request });
    await rejects(f.run(), ComputerConnectionError);
    expect(f.events.filter((x) => x === "observe")).toHaveLength(1);
    expect(f.received).toHaveLength(1);
    expect(f.events).toContain("port-close");
});

test("expired claims, reversed clocks and view-only input never reach a native action", async () => {
    for (const scenario of ["expired", "clock", "view"] as const) {
        const f = fixture(scenario === "view" ? "view" : "control");
        await f.controller.review();
        const request = { ...command(), ...f.controller.commandBinding() };
        f.handlers.claim = () => {
            if (scenario !== "view") f.advance(scenario === "expired" ? 5001 : -1);
            return {
                command:
                    scenario === "view"
                        ? {
                              ...request,
                              operation: {
                                  action: "click",
                                  observationId: crypto.randomUUID(),
                                  x: 1,
                                  y: 1,
                              },
                          }
                        : request,
            };
        };
        await rejects(f.run());
        expect(f.events).not.toContain("observe");
        expect(f.events).not.toContain("click");
        expect(f.received).toHaveLength(0);
        expect(f.events).toContain("port-close");
    }
});

test("lost result acknowledgement stops without retrying input or continuing the session", async () => {
    const f = fixture();
    await f.controller.review();
    const observed = await f.controller.observe(signal());
    f.handlers.claim = () => ({
        command: {
            ...command(),
            ...f.controller.commandBinding(),
            operation: {
                action: "type",
                observationId: observed.observationId,
                text: "synthetic",
            },
        },
    });
    f.handlers.finish = () => {
        throw new Error("offline");
    };
    await rejects(f.run(), ComputerConnectionError);
    expect(f.events.filter((x) => x === "type")).toHaveLength(1);
    expect(f.events.filter((x) => x === "claim")).toHaveLength(1);
    expect(f.received).toHaveLength(1);
    expect(f.events).toContain("port-close");
});

test("local stop discards a late capture and awaits its outstanding native cleanup", async () => {
    const f = fixture();
    await f.controller.review();
    const capture =
        Promise.withResolvers<Awaited<ReturnType<ComputerWindowPort["observe"]>>>();
    const cleanup = Promise.withResolvers<void>();
    f.port.observe = () => {
        f.events.push("capturing");
        return capture.promise;
    };
    f.cleanup(() => cleanup.promise);
    f.handlers.claim = () => ({
        command: { ...command(), ...f.controller.commandBinding() },
    });
    let settled = false;
    const running = f.run().finally(() => {
        settled = true;
    });
    while (!f.events.includes("capturing")) await Bun.sleep(1);
    f.local.abort();
    const image = frame();
    capture.resolve({
        snapshot: "synthetic",
        width: image.width,
        height: image.height,
        content: { content: image.content },
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    expect(f.received).toHaveLength(0);
    cleanup.resolve();
    await running;
    expect(f.events).toContain("host-close");
});

test("unknown native input is never published as success and cleanup failure stays terminal", async () => {
    for (const cleanupFails of [false, true]) {
        const f = fixture();
        await f.controller.review();
        const observed = await f.controller.observe(signal());
        f.port.type = () => {
            f.events.push("type");
            return Promise.resolve({ effect: "unknown" });
        };
        if (cleanupFails)
            f.cleanup(() => Promise.reject(new Error("uncertain process exit")));
        f.handlers.claim = () => ({
            command: {
                ...command(),
                ...f.controller.commandBinding(),
                operation: {
                    action: "type",
                    observationId: observed.observationId,
                    text: "synthetic",
                },
            },
        });
        await (cleanupFails ? rejects(f.run(), RuntimeCleanupError) : f.run());
        expect(f.events.filter((x) => x === "type")).toHaveLength(1);
        expect(f.received).toHaveLength(0);
        expect(f.events).toContain("host-close");
    }
});

test("operation deadline aborts a pending capture without a late result or replacement", async () => {
    const f = fixture();
    await f.controller.review();
    f.handlers.claim = () => ({
        command: { ...command(), ...f.controller.commandBinding(), validForMs: 20 },
    });
    f.port.observe = (operation) =>
        new Promise((_resolve, reject) => {
            f.events.push("capturing");
            operation.addEventListener("abort", () => reject(operation.reason as Error), {
                once: true,
            });
        });
    // The operation deadline is a terminal failure, not an instruction to replay on reconnect.
    await rejects(f.run());
    expect(f.events.filter((x) => x === "claim")).toHaveLength(1);
    expect(f.received).toHaveLength(0);
    expect(f.events).toContain("port-close");
});

test("transport rejects invalid credentials and malformed command payloads before any native work", async () => {
    let requests = 0;
    let response: unknown = { command: null };
    const client = new ComputerCompanion("https://private.example.test", () => {
        requests++;
        return Promise.resolve(Response.json(response));
    });
    await rejects(client.claimCommand("invalid", binding(), signal()));
    await rejects(client.finishCommand("invalid", command(), frame(), signal()));
    expect(requests).toBe(0);
    expect(await client.claimCommand(credential, binding(), signal())).toBeNull();
    response = {
        command: { ...command(), operation: { action: "shell", text: "untrusted" } },
    };
    await rejects(
        client.claimCommand(credential, binding(), signal()),
        ComputerConnectionError
    );
    expect(requests).toBe(2);
});

test("the command loop cannot poll or open a native port before consent", async () => {
    const f = fixture();
    await rejects(f.run(), /awaiting local consent/);
    expect(f.events).not.toContain("claim");
    expect(f.events).not.toContain("observe");
    expect(f.events).toContain("host-close");
});

test("the per-session command budget never evicts earlier replay protection", async () => {
    const f = fixture();
    await f.controller.review();
    const scope = f.controller.commandBinding();
    const picture = frame();
    f.port.observe = () =>
        Promise.resolve({
            snapshot: "synthetic",
            width: 390,
            height: 110,
            content: { content: picture.content },
        });
    f.handlers.claim = () => ({ command: { ...command(), ...scope } });
    await rejects(f.run(), ComputerConnectionError);
    expect(f.received).toHaveLength(1024);
    expect(f.events.filter((x) => x === "claim")).toHaveLength(1025);
    expect(f.events).toContain("port-close");
});

test("remote observation targets stay bounded, structured and distinct from raw instructions", () => {
    const valid = {
        ...frame(),
        coordinateInput: false,
        elements: [{ token: "s00000001:1", role: "button", label: "Untrusted label" }],
    };
    expect(computerCommandResult("observe", valid)).toEqual(valid);
    for (const elements of [
        [{ ...valid.elements[0], token: "1" }],
        [{ ...valid.elements[0], token: "s00000001:" + "1".repeat(33) }],
        [{ ...valid.elements[0], role: "x".repeat(65) }],
        [{ ...valid.elements[0], label: "x".repeat(129) }],
        [{ ...valid.elements[0], pid: 999 }],
        [...valid.elements, ...valid.elements],
        Array.from({ length: 201 }, (_, i) => ({
            ...valid.elements[0],
            token: `s00000001:${i}`,
        })),
    ])
        expect(() => computerCommandResult("observe", { ...valid, elements })).toThrow();
    expect(() =>
        computerCommandResult("observe", { ...valid, coordinateInput: "true" })
    ).toThrow();
    expect(computerCommandResult("click_element", { effect: "refused" })).toEqual({
        effect: "refused",
    });
});
