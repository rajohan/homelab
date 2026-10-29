import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { createVisualChallenge } from "../testing/visualChallenge";
import { serveComputerChild } from "./child";
import type { ComputerWindowPort } from "./session";

const grant = {
    executable: "/synthetic/app",
    pid: 123,
    windowId: "10",
    delivery: "foreground",
};
function fixture() {
    const input = new PassThrough();
    const output = new PassThrough();
    const replies: { id: number; result: unknown }[] = [];
    output.on("data", (data: Buffer) => {
        replies.push(JSON.parse(data.toString()) as { id: number; result: unknown });
    });
    const calls: string[] = [];
    let closes = 0;
    const port: ComputerWindowPort = {
        observe: () => {
            calls.push("observe");
            return Promise.resolve({
                snapshot: "frame",
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
        click: (x, y) => {
            calls.push(`click:${x}:${y}`);
            return Promise.resolve({ effect: "unverified" });
        },
        clickElement: (token) => {
            calls.push(`element:${token}`);
            return Promise.resolve({ effect: "confirmed" });
        },
        type: (text) => {
            calls.push(`type:${text}`);
            return Promise.resolve({ effect: "confirmed" });
        },
        close: () => {
            closes++;
            return Promise.resolve();
        },
    };
    const opened: unknown[] = [];
    const done = serveComputerChild(input, output, (value) => {
        opened.push(value);
        return Promise.resolve(port);
    });
    const send = async (id: number, method: string, params: unknown) => {
        input.write(JSON.stringify({ id, method, params }) + "\n");
        for (
            let attempt = 0;
            attempt < 100 && !replies.some((reply) => reply.id === id);
            attempt++
        )
            await Bun.sleep(1);
    };
    return {
        input,
        output,
        done,
        send,
        calls,
        port,
        opened,
        replies,
        closes: () => closes,
    };
}

test("the private child permits only one initialization and fixed native operations", async () => {
    const f = fixture();
    await f.send(1, "initialize", grant);
    await f.send(2, "observe", {});
    await f.send(3, "click", { x: 4, y: 8 });
    await f.send(4, "type", { text: "literal text" });
    await f.send(5, "click_element", { elementToken: "s00000001:1" });
    expect(f.opened).toEqual([grant]);
    expect(f.calls).toEqual([
        "observe",
        "click:4:8",
        "type:literal text",
        "element:s00000001:1",
    ]);
    expect(f.replies.map((reply) => reply.id)).toEqual([1, 2, 3, 4, 5]);
    expect(f.replies[0]?.result).toEqual({ version: 1, driver: "0.37.0" });
    expect(f.replies[2]?.result).toEqual({ effect: "unverified" });
    f.input.end();
    await f.done;
    expect(f.closes()).toBe(1);
});

test("invalid, repeated, overflowing and privilege-widening requests retire the child", async () => {
    for (const invalid of [
        JSON.stringify({
            id: 2,
            method: "click_element",
            params: { elementToken: "1" },
        }) + "\n",
        JSON.stringify({
            id: 2,
            method: "click_element",
            params: { elementToken: "s00000001:1", pid: 999 },
        }) + "\n",
        JSON.stringify({ id: 2, method: "shell", params: {} }) + "\n",
        JSON.stringify({ id: 2, method: "initialize", params: grant }) + "\n",
        JSON.stringify({ id: 1, method: "observe", params: {} }) + "\n",
        JSON.stringify({ id: 2, method: "observe", params: { pid: 456 } }) + "\n",
        JSON.stringify({ id: 2, method: "click", params: { x: -1, y: 3 } }) + "\n",
        JSON.stringify({ id: 2, method: "type", params: { text: "x".repeat(4097) } }) +
            "\n",
        JSON.stringify({ id: 2, method: "observe", params: {}, extra: true }) + "\n",
        "invalid\n",
        " ".repeat(32 * 1024 + 1),
        '{"id":2,"method":"observe","params":{}}\n{}\n',
    ]) {
        const f = fixture();
        await f.send(1, "initialize", grant);
        f.input.write(invalid);
        await f.done;
        expect(f.calls).toEqual([]);
        expect(f.closes()).toBe(1);
        expect(f.replies).toHaveLength(1);
    }
});

test("requests before initialization and invalid grants cannot open native authority", async () => {
    for (const command of [
        { method: "observe", params: {} },
        { method: "initialize", params: { ...grant, tool: "shell" } },
    ]) {
        const f = fixture();
        f.input.write(JSON.stringify({ id: 1, ...command }) + "\n");
        await f.done;
        expect(f.opened).toEqual([]);
        expect(f.replies).toEqual([]);
    }
});

test("pipe loss aborts in-flight input and emits no late success", async () => {
    for (const mode of ["end", "overlap", "error", "close"]) {
        const f = fixture();
        await f.send(1, "initialize", grant);
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        f.port.type = (_text, signal) =>
            new Promise((_resolve, reject) => {
                f.calls.push("type");
                entered();
                signal.addEventListener(
                    "abort",
                    () => {
                        reject(new Error("private driver detail"));
                    },
                    { once: true }
                );
            });
        f.input.write(
            JSON.stringify({ id: 2, method: "type", params: { text: "once" } }) + "\n"
        );
        await ready;
        if (mode === "end") f.input.end();
        if (mode === "close") f.input.destroy();
        if (mode === "overlap")
            f.input.write('{"id":3,"method":"observe","params":{}}\n');
        if (mode === "error") f.output.emit("error", new Error("broken pipe"));
        await f.done;
        expect(f.calls).toEqual(["type"]);
        expect(f.replies).toHaveLength(1);
        expect(f.closes()).toBe(1);
    }
});

test("fragmented frames are bounded and native failures never expose diagnostics", async () => {
    const f = fixture();
    const line = JSON.stringify({ id: 1, method: "initialize", params: grant }) + "\n";
    f.input.write(line.slice(0, 5));
    f.input.write(line.slice(5));
    while (f.replies.length === 0) await Bun.sleep(1);
    f.port.observe = () => Promise.reject(new Error("private native diagnostic"));
    f.input.write('{"id":2,"method":"observe","params":{}}\n');
    await f.done;
    expect(f.replies).toHaveLength(1);
    expect(f.closes()).toBe(1);
});

test("late native initialization is closed after parent EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const f = fixture();
    f.input.end();
    await f.done;
    let resolveOpen!: (port: ComputerWindowPort) => void;
    const opening = new Promise<ComputerWindowPort>((resolve) => {
        resolveOpen = resolve;
    });
    const replies: Buffer[] = [];
    output.on("data", (data: Buffer) => {
        replies.push(data);
    });
    const done = serveComputerChild(input, output, () => opening);
    input.write(JSON.stringify({ id: 1, method: "initialize", params: grant }) + "\n");
    input.end();
    await Bun.sleep(1);
    resolveOpen(f.port);
    await done;
    expect(f.closes()).toBe(1);
    expect(replies).toEqual([]);
});
