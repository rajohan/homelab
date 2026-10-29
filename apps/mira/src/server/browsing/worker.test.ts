import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import * as v from "valibot";

import { createVisualChallenge } from "../testing/visualChallenge";
import { serveBrowserWorker } from "./child";
import { openBrowserWorker } from "./process";
import { browserWorkerFrame, browserWorkerGrant } from "./wire";

const grant = {
    origins: ["http://fixture.invalid"],
    initialUrl: "http://fixture.invalid/",
    mode: "control" as const,
};
function frame() {
    return {
        observationId: randomUUID(),
        url: grant.initialUrl,
        title: "Synthetic browser",
        outline: "Fixture",
        complete: true,
        refs: [
            {
                ref: "p1:1",
                role: "textbox",
                label: "Text",
                actions: ["click", "type"] as ("click" | "type")[],
            },
        ],
        width: 390,
        height: 110,
        content: {
            content: [
                {
                    type: "image" as const,
                    mediaType: "image/png" as const,
                    data: createVisualChallenge().data,
                },
            ],
        },
    };
}
function childFixture() {
    const input = new PassThrough(),
        output = new PassThrough();
    const replies: { id: number; result: unknown }[] = [];
    const calls: string[] = [],
        opened: unknown[] = [];
    let closes = 0,
        forced = 0;
    const port = {
        observe: (_signal: AbortSignal) => {
            calls.push("observe");
            return Promise.resolve(frame());
        },
        navigate: (url: unknown, _signal: AbortSignal) => {
            calls.push("navigate");
            return Promise.resolve({ url: String(url) });
        },
        act: (_input: unknown, _signal: AbortSignal) => {
            calls.push("act");
            return Promise.resolve({ effect: "unverified" as const });
        },
        close: () => {
            closes++;
            return Promise.resolve();
        },
    };
    let opening: Promise<typeof port> | undefined;
    const done = serveBrowserWorker(
        input,
        output,
        (value, signal) => {
            opened.push(value);
            signal.addEventListener("abort", () => calls.push("aborted"), { once: true });
            return opening ?? Promise.resolve(port);
        },
        () => {
            forced++;
        }
    );
    output.on("data", (chunk: Buffer) =>
        replies.push(
            JSON.parse(chunk.toString("utf8")) as { id: number; result: unknown }
        )
    );
    const write = (id: number, method: string, params: unknown) =>
        input.write(JSON.stringify({ id, body: { method, params } }) + "\n");
    const send = async (id: number, method: string, params: unknown) => {
        write(id, method, params);
        const deadline = performance.now() + 500;
        while (!replies.some((reply) => reply.id === id) && performance.now() < deadline)
            await Bun.sleep(1);
        const reply = replies.find((reply) => reply.id === id);
        assert.ok(reply);
        return reply.result;
    };
    return {
        input,
        output,
        done,
        port,
        calls,
        opened,
        replies,
        send,
        write,
        holdOpen: (value: Promise<typeof port>) => {
            opening = value;
        },
        closes: () => closes,
        forced: () => forced,
    };
}

test("worker grant and observation validation refuse authority widening and malformed images", () => {
    expect(browserWorkerGrant(grant)).toEqual(grant);
    for (const value of [
        { ...grant, executable: "/other" },
        { ...grant, profile: "existing" },
        { ...grant, initialUrl: "https://outside.invalid/" },
        { ...grant, origins: ["http://fixture.invalid/"] },
    ])
        expect(() => browserWorkerGrant(value)).toThrow();
    expect(browserWorkerFrame(frame(), grant.origins).title).toBe("Synthetic browser");
    for (const change of [
        (value: ReturnType<typeof frame>) => {
            value.width++;
        },
        (value: ReturnType<typeof frame>) => {
            value.url = "https://outside.invalid/";
        },
        (value: ReturnType<typeof frame>) => {
            value.refs.push(value.refs[0]!);
        },
        (value: ReturnType<typeof frame>) => {
            value.refs.push({ ...value.refs[0]!, ref: "p2:2" });
        },
        (value: ReturnType<typeof frame>) => {
            value.refs[0]!.actions = ["click", "click"];
        },
        (value: ReturnType<typeof frame>) => {
            value.content.content[0]!.data = "invalid";
        },
    ]) {
        const value = frame();
        change(value);
        expect(() => browserWorkerFrame(value, grant.origins)).toThrow();
    }
});

test("worker fixes its executable and serves only initialized browser operations", async () => {
    const f = childFixture();
    expect(await f.send(1, "initialize", grant)).toEqual({
        version: 1,
        driver: "0.37.0",
    });
    expect(f.opened).toEqual([{ ...grant, executable: "/usr/lib/chromium/chromium" }]);
    const observation = browserWorkerFrame(await f.send(2, "observe", {}), grant.origins);
    expect(
        await f.send(3, "act", {
            action: "type",
            observationId: observation.observationId,
            ref: "p1:1",
            text: "Literal text",
            replace: true,
        })
    ).toEqual({ effect: "unverified" });
    expect(await f.send(4, "navigate", { url: "http://fixture.invalid/next" })).toEqual({
        url: "http://fixture.invalid/next",
    });
    f.input.end();
    await f.done;
    expect(f.calls).toEqual(["observe", "act", "navigate", "aborted"]);
    expect(f.closes()).toBe(1);
    expect(f.forced()).toBe(0);
});

test("unknown, overlapping, malformed and widening commands terminate without native dispatch", async () => {
    for (const invalid of [
        { id: 2, body: { method: "shell", params: {} } },
        { id: 2, body: { method: "initialize", params: grant } },
        { id: 1, body: { method: "observe", params: {} } },
        { id: 2, body: { method: "observe", params: { targetId: "other" } } },
        {
            id: 2,
            body: { method: "navigate", params: { url: "http://outside.invalid/" } },
        },
        {
            id: 2,
            body: {
                method: "act",
                params: {
                    action: "click",
                    observationId: randomUUID(),
                    ref: "p1:1",
                    x: 5,
                },
            },
        },
        {
            id: 2,
            body: {
                method: "act",
                params: {
                    action: "type",
                    observationId: randomUUID(),
                    ref: "p1:1",
                    text: "\0",
                    replace: true,
                },
            },
        },
    ]) {
        const f = childFixture();
        await f.send(1, "initialize", grant);
        f.input.write(JSON.stringify(invalid) + "\n");
        await f.done;
        expect(f.calls).toEqual(["aborted"]);
        expect(f.replies).toHaveLength(1);
        expect(f.closes()).toBe(1);
    }
    for (const data of [
        "invalid\n",
        "x".repeat(65_537),
        "{}\n{}\n",
        Buffer.from([0xff, 10]),
    ]) {
        const f = childFixture();
        f.input.write(data);
        await f.done;
        expect(f.opened).toHaveLength(0);
        expect(f.replies).toHaveLength(0);
    }
    for (const command of [
        { method: "observe", params: {} },
        { method: "initialize", params: { ...grant, executable: "/other" } },
    ]) {
        const f = childFixture();
        f.write(1, command.method, command.params);
        await f.done;
        expect(f.opened).toHaveLength(0);
    }
    const view = childFixture();
    await view.send(1, "initialize", { ...grant, mode: "view" });
    view.write(2, "act", { action: "click", observationId: randomUUID(), ref: "p1:1" });
    await view.done;
    expect(view.calls).toEqual(["aborted"]);
});

test("worker pipe loss cancels an active call and never returns a late success", async () => {
    for (const reason of ["end", "error", "output", "overlap"] as const) {
        const f = childFixture();
        await f.send(1, "initialize", grant);
        const entered = Promise.withResolvers<void>();
        f.port.observe = (signal) =>
            new Promise((_resolve, reject) => {
                f.calls.push("observe");
                entered.resolve();
                signal.addEventListener(
                    "abort",
                    () => reject(new Error("synthetic cancellation")),
                    { once: true }
                );
            });
        f.write(2, "observe", {});
        await entered.promise;
        if (reason === "end") f.input.end();
        if (reason === "error") f.input.destroy(new Error("private diagnostic"));
        if (reason === "output") f.output.destroy();
        if (reason === "overlap") f.write(3, "observe", {});
        await f.done;
        expect(f.replies).toHaveLength(1);
        expect(f.closes()).toBe(1);
    }
});

test("worker waits for late initialization and preserves cleanup failure", async () => {
    const f = childFixture();
    const delayed = Promise.withResolvers<typeof f.port>();
    f.holdOpen(delayed.promise);
    f.write(1, "initialize", grant);
    f.input.end();
    delayed.resolve(f.port);
    await f.done;
    expect(f.closes()).toBe(1);
    expect(f.replies).toHaveLength(0);
    const failed = childFixture();
    await failed.send(1, "initialize", grant);
    failed.port.close = () => Promise.reject(new Error("native diagnostic"));
    const rejected = assert.rejects(failed.done, /cleanup did not complete/);
    failed.input.end();
    await rejected;
});

async function hostFixture(
    mode: "view" | "control" = "control",
    handler?: (method: string, params: unknown) => Promise<unknown>
) {
    const lifetime = new AbortController();
    const calls: { method: string; params: unknown }[] = [];
    let closes = 0,
        clock = 1;
    const connection = {
        signal: lifetime.signal,
        request: async (body: unknown, _operation: AbortSignal) => {
            const command = v.parse(
                v.strictObject({ method: v.string(), params: v.unknown() }),
                body
            );
            calls.push(command);
            if (handler) return handler(command.method, command.params);
            if (command.method === "initialize") return { version: 1, driver: "0.37.0" };
            if (command.method === "observe") return frame();
            if (command.method === "navigate") return command.params;
            return { effect: "unverified" };
        },
        close: () => {
            closes++;
            lifetime.abort();
            return Promise.resolve();
        },
    };
    const port = await openBrowserWorker(
        {},
        { ...grant, mode },
        new AbortController().signal,
        () => Promise.resolve(connection),
        () => clock
    );
    return {
        port,
        connection,
        calls,
        closes: () => closes,
        setClock: (value: number) => {
            clock = value;
        },
    };
}

test("host validates version and permits one action from a fresh immutable observation", async () => {
    const f = await hostFixture();
    const owner = new AbortController().signal;
    expect(f.calls[0]).toEqual({ method: "initialize", params: grant });
    const observed = await f.port.observe(owner);
    const action = {
        action: "click",
        observationId: observed.observationId,
        ref: "p1:1",
    };
    expect(await f.port.act(action, owner)).toEqual({ effect: "unverified" });
    await assert.rejects(f.port.act(action, owner), /Do not replay/);
    expect(f.calls.filter((call) => call.method === "act")).toHaveLength(1);
    expect(f.closes()).toBe(1);
    const navigation = await hostFixture();
    expect(await navigation.port.navigate("http://fixture.invalid/next", owner)).toEqual({
        url: "http://fixture.invalid/next",
    });
    await navigation.port.close();
});

test("host refuses stale, forged, mutated, navigated and view-only observations before dispatch", async () => {
    const signal = new AbortController().signal;
    for (const reason of [
        "old",
        "clock",
        "id",
        "ref",
        "mutated",
        "navigation",
        "newer",
        "view",
    ] as const) {
        const f = await hostFixture(reason === "view" ? "view" : "control");
        const observed = await f.port.observe(signal);
        const action = {
            action: "click",
            observationId: observed.observationId,
            ref: "p1:1",
        };
        if (reason === "old") f.setClock(10_002);
        if (reason === "clock") f.setClock(0);
        if (reason === "id") action.observationId = randomUUID();
        if (reason === "ref") action.ref = "p1:9";
        if (reason === "mutated") {
            observed.refs.push({ ...observed.refs[0]!, ref: "p1:9" });
            action.ref = "p1:9";
        }
        if (reason === "navigation") await f.port.navigate(grant.initialUrl, signal);
        if (reason === "newer") await f.port.observe(signal);
        await assert.rejects(f.port.act(action, signal), /Do not replay/);
        expect(f.calls.filter((call) => call.method === "act")).toHaveLength(0);
        expect(f.closes()).toBe(1);
    }
});

test("host retires mismatched worker results and keeps cleanup errors authoritative", async () => {
    for (const phase of ["initialize", "observe", "navigate", "act"] as const) {
        let closed = 0;
        const connection = {
            signal: new AbortController().signal,
            request: (body: unknown) => {
                const command = v.parse(v.object({ method: v.string() }), body);
                if (command.method === phase) return Promise.resolve({ invalid: true });
                if (command.method === "observe") return Promise.resolve(frame());
                return Promise.resolve({ version: 1, driver: "0.37.0" });
            },
            close: () => {
                closed++;
                return Promise.resolve();
            },
        };
        const open = openBrowserWorker({}, grant, new AbortController().signal, () =>
            Promise.resolve(connection)
        );
        if (phase === "initialize") await assert.rejects(open, /Do not replay/);
        else {
            const port = await open;
            const signal = new AbortController().signal;
            if (phase === "observe")
                await assert.rejects(port.observe(signal), /Do not replay/);
            if (phase === "navigate")
                await assert.rejects(
                    port.navigate(grant.initialUrl, signal),
                    /Do not replay/
                );
            if (phase === "act") {
                const view = await port.observe(signal);
                await assert.rejects(
                    port.act(
                        {
                            action: "click",
                            observationId: view.observationId,
                            ref: "p1:1",
                        },
                        signal
                    ),
                    /Do not replay/
                );
            }
        }
        expect(closed).toBe(1);
    }
    const failure = new Error("cleanup unconfirmed");
    await assert.rejects(
        openBrowserWorker({}, grant, new AbortController().signal, () =>
            Promise.resolve({
                signal: new AbortController().signal,
                request: () => Promise.resolve({}),
                close: () => Promise.reject(failure),
            })
        ),
        (error) => error === failure
    );
});

test("host rejects concurrent operations without cancelling the first and invalid grants before opening", async () => {
    const response = Promise.withResolvers<unknown>();
    const f = await hostFixture("control", (method) =>
        method === "initialize"
            ? Promise.resolve({ version: 1, driver: "0.37.0" })
            : response.promise
    );
    const signal = new AbortController().signal;
    const active = f.port.observe(signal);
    await assert.rejects(f.port.observe(signal), /active operation/);
    expect(f.closes()).toBe(0);
    response.resolve(frame());
    await active;
    await f.port.close();
    await assert.rejects(openBrowserWorker({}, grant, AbortSignal.abort()));
    let opened = false;
    await assert.rejects(
        openBrowserWorker({}, { ...grant, profile: "personal" }, signal, () => {
            opened = true;
            return Promise.reject(new Error("unexpected"));
        })
    );
    expect(opened).toBe(false);
});

test("worker accepts fragmented input and refuses already closed pipes", async () => {
    const f = childFixture();
    const message =
        JSON.stringify({ id: 1, body: { method: "initialize", params: grant } }) + "\n";
    for (const byte of Buffer.from(message)) f.input.write(Buffer.from([byte]));
    const deadline = performance.now() + 500;
    while (f.replies.length === 0 && performance.now() < deadline) await Bun.sleep(1);
    expect(f.replies).toHaveLength(1);
    await f.send(2, "observe", {});
    f.input.end();
    await f.done;
    expect(f.opened).toHaveLength(1);
    const input = new PassThrough(),
        output = new PassThrough();
    input.destroy();
    await serveBrowserWorker(
        input,
        output,
        () => Promise.reject(new Error("unexpected open")),
        () => {
            throw new Error("unexpected forced exit");
        }
    );
    expect(output.destroyed).toBe(true);
});

test("worker requests forced exit without declaring hung native cleanup successful", async () => {
    const f = childFixture();
    await f.send(1, "initialize", grant);
    const cleanup = Promise.withResolvers<void>();
    f.port.close = () => cleanup.promise;
    let completed = false;
    const done = f.done.then(() => {
        completed = true;
        return true;
    });
    f.input.end();
    try {
        const deadline = performance.now() + 2500;
        while (f.forced() === 0 && performance.now() < deadline) await Bun.sleep(10);
        expect(f.forced()).toBe(1);
        expect(completed).toBe(false);
        expect(f.output.destroyed).toBe(true);
    } finally {
        cleanup.resolve();
        await done;
    }
});

test("failed initialization never reports successful worker cleanup without a port", async () => {
    const input = new PassThrough(),
        output = new PassThrough();
    const done = serveBrowserWorker(
        input,
        output,
        () => Promise.reject(new Error("native initialization cleanup failed")),
        () => {
            throw new Error("unexpected forced exit");
        }
    );
    const rejected = assert.rejects(done, /cleanup did not complete/);
    input.write(
        JSON.stringify({ id: 1, body: { method: "initialize", params: grant } }) + "\n"
    );
    await rejected;
    expect(output.destroyed).toBe(true);
});

test("host assigns the aggregate deadline only to initialization", async () => {
    const deadlines: (number | undefined)[] = [];
    const port = await openBrowserWorker({}, grant, new AbortController().signal, () =>
        Promise.resolve({
            signal: new AbortController().signal,
            request: (body: unknown, _signal: AbortSignal, timeout?: number) => {
                deadlines.push(timeout);
                const command = v.parse(v.object({ method: v.string() }), body);
                return Promise.resolve(
                    command.method === "initialize"
                        ? { version: 1, driver: "0.37.0" }
                        : frame()
                );
            },
            close: () => Promise.resolve(),
        })
    );
    await port.observe(new AbortController().signal);
    await port.close();
    expect(deadlines).toEqual([60_000, undefined]);
});
