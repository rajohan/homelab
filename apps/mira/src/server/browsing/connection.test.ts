import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";

import { browserDockerFrames } from "./attach";
import { openBrowserConnection } from "./connection";
import { BrowserContainerCleanupError } from "./container";

const config = {
    socketPath: "/synthetic/engine.sock",
    imageId: `sha256:${"a".repeat(64)}`,
};
const id = "b".repeat(64);
function frame(body: Buffer | string) {
    const data = Buffer.from(body);
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
}
async function fixture(
    options: {
        cleanup?: () => Promise<void>;
        timeout?: number;
        start?: () => Promise<void>;
    } = {}
) {
    const owner = new AbortController();
    const lifetime = new AbortController();
    const writes: string[] = [];
    const events: string[] = [];
    const stream = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
            writes.push(String(chunk));
            callback();
        },
    });
    const lease = {
        id,
        name: "mira-browser-synthetic",
        signal: lifetime.signal,
        start: async () => {
            events.push("start");
            await options.start?.();
        },
        close: async () => {
            events.push("close");
            lifetime.abort();
            await options.cleanup?.();
        },
    };
    const connection = await openBrowserConnection(config, owner.signal, {
        prepare: () => {
            events.push("create");
            return Promise.resolve(lease);
        },
        attach: (socket, selected) => {
            expect(socket).toBe(config.socketPath);
            expect(selected).toBe(id);
            events.push("attach");
            return Promise.resolve(stream);
        },
        requestTimeoutMs: options.timeout ?? 1000,
    });
    const reply = (result: unknown, requestId = 1) =>
        stream.push(frame(JSON.stringify({ id: requestId, result }) + "\n"));
    return { owner, lifetime, writes, events, stream, connection, reply };
}

test("Docker stdout decoding preserves fragmented headers, payloads and multiple frames", () => {
    const parts: Buffer[] = [];
    const receive = browserDockerFrames((bytes) => parts.push(bytes));
    const encoded = Buffer.concat([frame("one"), frame("two")]);
    for (const byte of encoded) receive(Buffer.from([byte]));
    expect(Buffer.concat(parts).toString()).toBe("onetwo");
    for (const [byte, value] of [
        [0, 0],
        [0, 2],
        [1, 1],
        [2, 1],
        [3, 1],
    ] as const) {
        const broken = frame("x");
        broken[byte] = value;
        expect(() => browserDockerFrames(() => {})(broken)).toThrow();
    }
    for (const length of [0, 4 * 1024 * 1024 + 1]) {
        const broken = frame("x").subarray(0, 8);
        broken.writeUInt32BE(length, 4);
        expect(() => browserDockerFrames(() => {})(broken)).toThrow();
    }
});

test("attachment precedes startup and one request receives only its own untrusted result", async () => {
    const f = await fixture();
    expect(f.events).toEqual(["create", "attach", "start"]);
    try {
        const first = f.connection.request({ operation: "observe" }, f.owner.signal);
        await assert.rejects(f.connection.request({}, f.owner.signal), /busy/);
        expect(f.writes.map((line) => JSON.parse(line) as unknown)).toEqual([
            { id: 1, body: { operation: "observe" } },
        ]);
        const wire = frame(
            JSON.stringify({ id: 1, result: { title: "Untrusted 😀" } }) + "\n"
        );
        for (let offset = 0; offset < wire.length; offset += 3)
            f.stream.push(wire.subarray(offset, offset + 3));
        expect(await first).toEqual({ title: "Untrusted 😀" });
        const second = f.connection.request({}, f.owner.signal);
        f.reply(null, 2);
        expect(await second).toBeNull();
        expect(f.writes.length).toBe(2);
    } finally {
        await f.connection.close();
    }
    expect(f.connection.signal.aborted).toBe(true);
    await assert.rejects(f.connection.request({}, f.owner.signal), /Do not replay/);
    await f.connection.close();
    expect(f.events.filter((event) => event === "close")).toHaveLength(1);
});

test("request limits and pre-cancellation never dispatch oversized or unwanted input", async () => {
    const f = await fixture();
    try {
        expect(() => f.connection.request("x".repeat(65_536), f.owner.signal)).toThrow(
            /limit/
        );
        expect(() => f.connection.request({}, AbortSignal.abort())).toThrow();
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(() => f.connection.request(cyclic, f.owner.signal)).toThrow();
        expect(f.writes).toHaveLength(0);
    } finally {
        await f.connection.close();
    }
});

test("invalid replies, unsolicited frames and truncated streams permanently retire the lease", async () => {
    const invalid = [
        frame("not JSON\n"),
        frame('{"id":2,"result":true}\n'),
        frame('{"id":1,"result":true,"method":"execute"}\n'),
        frame('{"id":1,"result":true}\n{}\n'),
        frame(Buffer.from([0xff, 10])),
        frame("x".repeat(4 * 1024 * 1024) + "\n"),
    ];
    for (const bytes of invalid) {
        const f = await fixture();
        const result = assert.rejects(
            f.connection.request({ operation: "click" }, f.owner.signal),
            /Do not replay/
        );
        f.stream.push(bytes);
        await result;
        await f.connection.close();
        expect(f.writes).toHaveLength(1);
        expect(f.events.filter((event) => event === "close")).toHaveLength(1);
    }
    for (const ending of ["end", "error", "partial"] as const) {
        const f = await fixture();
        const result = assert.rejects(
            f.connection.request({}, f.owner.signal),
            /Do not replay/
        );
        if (ending === "error") f.stream.destroy(new Error("secret diagnostic"));
        else {
            if (ending === "partial") f.stream.push(frame("unfinished").subarray(0, 10));
            f.stream.push(null);
        }
        await result;
        await f.connection.close();
    }
    const idle = await fixture();
    idle.reply("unsolicited");
    await new Promise((resolve) => setImmediate(resolve));
    expect(idle.connection.signal.aborted).toBe(true);
    await idle.connection.close();
});

test("aggregate reply limit applies across individually valid Docker frames", async () => {
    const f = await fixture();
    const failed = assert.rejects(
        f.connection.request({}, f.owner.signal),
        /Do not replay/
    );
    const bytes = frame("x".repeat(1024 * 1024));
    for (let index = 0; index < 5; index++) f.stream.push(bytes);
    await failed;
    await f.connection.close();
});

test("cancellation and timeout await removal before rejecting an uncertain operation", async () => {
    for (const reason of ["owner", "lease", "operation", "timeout", "close"] as const) {
        const cleanup = Promise.withResolvers<void>();
        const f = await fixture({
            cleanup: () => cleanup.promise,
            timeout: reason === "timeout" ? 10 : 1000,
        });
        const operation = new AbortController();
        let finished = false;
        const result = assert
            .rejects(
                f.connection.request(
                    { operation: "type", text: "once" },
                    operation.signal
                ),
                /Do not replay/
            )
            .then(() => {
                finished = true;
                return true;
            });
        if (reason === "owner") f.owner.abort();
        if (reason === "lease") f.lifetime.abort();
        if (reason === "operation") operation.abort();
        if (reason === "close") void f.connection.close();
        await Bun.sleep(reason === "timeout" ? 30 : 1);
        expect(f.connection.signal.aborted).toBe(true);
        expect(finished).toBe(false);
        expect(f.writes).toHaveLength(1);
        cleanup.resolve();
        await result;
        await f.connection.close();
    }
});

test("unconfirmed cleanup is sticky and takes precedence over an unknown input result", async () => {
    const error = new BrowserContainerCleanupError("mira-browser-synthetic");
    const f = await fixture({ cleanup: () => Promise.reject(error) });
    const result = assert.rejects(
        f.connection.request({}, f.owner.signal),
        (actual) => actual === error
    );
    f.owner.abort();
    await result;
    await assert.rejects(
        f.connection.request({}, new AbortController().signal),
        (actual) => actual === error
    );
    for (let index = 0; index < 2; index++)
        await assert.rejects(f.connection.close(), (actual) => actual === error);
    expect(f.events.filter((event) => event === "close")).toHaveLength(1);
});

test("failed attachment or startup cannot leak or restart a container", async () => {
    for (const failure of ["attach", "start", "cancel", "cleanup"] as const) {
        let starts = 0,
            closes = 0;
        const owner = new AbortController();
        const stream = new Duplex({
            read() {},
            write(_chunk, _encoding, callback) {
                callback();
            },
        });
        const lease = {
            id,
            name: "synthetic",
            signal: owner.signal,
            start: () => {
                starts++;
                return Promise.reject(new Error("start refused"));
            },
            close: () => {
                closes++;
                if (failure === "cleanup")
                    return Promise.reject(new BrowserContainerCleanupError("synthetic"));
                return Promise.resolve();
            },
        };
        await assert.rejects(
            openBrowserConnection(config, owner.signal, {
                prepare: () => Promise.resolve(lease),
                attach: () => {
                    if (failure === "attach" || failure === "cleanup")
                        return Promise.reject(new Error("attach refused"));
                    if (failure === "cancel") owner.abort();
                    return Promise.resolve(stream);
                },
            }),
            failure === "cleanup" ? /cleanup/ : /./
        );
        expect(closes).toBe(1);
        expect(starts).toBe(failure === "start" ? 1 : 0);
        stream.destroy();
    }
    for (const timeout of [0, 30_001, 0.5, Number.NaN])
        await assert.rejects(
            openBrowserConnection(config, new AbortController().signal, {
                requestTimeoutMs: timeout,
            }),
            /deadline/
        );
    await assert.rejects(openBrowserConnection(config, AbortSignal.abort()));
    await assert.rejects(
        openBrowserConnection(
            { ...config, command: "forbidden" },
            new AbortController().signal
        )
    );
});

test("successful requests retain permanent owner cancellation between operations", async () => {
    const f = await fixture();
    const response = f.connection.request({}, f.owner.signal);
    f.reply("observed");
    expect(await response).toBe("observed");
    f.owner.abort();
    expect(f.connection.signal.aborted).toBe(true);
    await f.connection.close();
    expect(f.events.filter((event) => event === "close")).toHaveLength(1);
});

test("a reply cannot complete before its declared Docker frame has arrived", async () => {
    const f = await fixture();
    const failed = assert.rejects(
        f.connection.request({}, f.owner.signal),
        /Do not replay/
    );
    const bytes = frame('{"id":1,"result":true}\n');
    bytes.writeUInt32BE(bytes.length - 8 + 10, 4);
    f.stream.push(bytes);
    await failed;
    await f.connection.close();
});

test("only the initial handshake can extend the transport deadline to sixty seconds", async () => {
    const f = await fixture({ timeout: 10 });
    try {
        for (const timeout of [0, 60_001, 0.5, Number.NaN])
            expect(() => f.connection.request({}, f.owner.signal, timeout)).toThrow(
                /deadline/
            );
        const startup = f.connection.request(
            { method: "initialize" },
            f.owner.signal,
            60_000
        );
        await Bun.sleep(30);
        expect(f.connection.signal.aborted).toBe(false);
        f.reply({ ready: true });
        expect(await startup).toEqual({ ready: true });
        expect(() => f.connection.request({}, f.owner.signal, 60_000)).toThrow(
            /deadline/
        );
        expect(f.writes).toHaveLength(1);
        const ordinary = assert.rejects(
            f.connection.request({}, f.owner.signal),
            /Do not replay/
        );
        await ordinary;
    } finally {
        await f.connection.close();
    }
});
