import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createVisualChallenge } from "../testing/visualChallenge";
import { createCaptureRunner, openWindowsCapture } from "./windowsCapture";

const signal = () => new AbortController().signal;
const image = () => Buffer.from(createVisualChallenge().data, "base64");
const grant = async () => ({
    executable: await realpath(process.execPath),
    pid: 123,
    windowId: "456",
    startedAt: "123456789",
    delivery: "foreground",
});

test("capture freezes local creation identity and exports only a bounded PNG", async () => {
    const target = await grant();
    const calls: string[][] = [];
    const original = image();
    const port = await openWindowsCapture(target, (args) => {
        calls.push(args);
        return Promise.resolve(original);
    });
    target.startedAt = "999";
    const frame = await port.read(signal());
    expect(frame).toMatchObject({ width: 390, height: 110 });
    expect(calls).toEqual([["123", "456", "123456789"]]);
    expect(Buffer.from(frame.dataBase64, "base64").equals(original)).toBe(true);
    await port.close();
    await rejects(port.read(signal()));
});

test("capture refuses missing creation identity and unavailable installed helpers", async () => {
    await rejects(
        openWindowsCapture({ ...(await grant()), startedAt: undefined }, () =>
            Promise.resolve(image())
        ),
        /creation identity/
    );
    await rejects(openWindowsCapture(await grant()));
});

test("capture rejects malformed, truncated and excessive pixels without leaking native output", async () => {
    const large = image();
    large.writeUInt32BE(8193, 16);
    const pixels = image();
    pixels.writeUInt32BE(8192, 16);
    pixels.writeUInt32BE(8192, 20);
    const empty = image();
    empty.writeUInt32BE(0, 16);
    for (const bytes of [
        Buffer.from("private diagnostic"),
        image().subarray(0, 30),
        Buffer.alloc(3 * 1024 * 1024 + 1),
        large,
        pixels,
        empty,
    ]) {
        const port = await openWindowsCapture(await grant(), () =>
            Promise.resolve(bytes)
        );
        await rejects(port.read(signal()), {
            message: "Window-only capture is unavailable.",
        });
        await port.close();
    }
    const port = await openWindowsCapture(await grant(), () =>
        Promise.reject(new Error("private diagnostic"))
    );
    await rejects(port.read(signal()), {
        message: "Window-only capture is unavailable.",
    });
    await port.close();
});

test("close aborts the active capture and waits for its helper, rejecting concurrent reads", async () => {
    let finish!: (data: Buffer) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
        began = resolve;
    });
    let childSignal: AbortSignal | undefined;
    const port = await openWindowsCapture(await grant(), (_args, current) => {
        childSignal = current;
        began();
        return new Promise<Buffer>((resolve) => {
            finish = resolve;
        });
    });
    const pending = port.read(signal());
    const refused = rejects(pending, /unavailable/);
    await started;
    await rejects(port.read(signal()), /already active/);
    let closed = false;
    const closing = port.close().then(() => {
        return (closed = true);
    });
    await Promise.resolve();
    expect(childSignal?.aborted).toBe(true);
    expect(closed).toBe(false);
    finish(image());
    await Promise.all([closing, refused]);
    expect(closed).toBe(true);
    await port.close();
});

test("capture never starts work for an already cancelled request", async () => {
    const abort = new AbortController();
    abort.abort();
    let called = false;
    const port = await openWindowsCapture(await grant(), () => {
        called = true;
        return Promise.resolve(image());
    });
    await rejects(port.read(abort.signal));
    expect(called).toBe(false);
    await port.close();
});

test("real capture transport bounds output, redacts failures and reaps cancellation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mira-capture-pipe-"));
    const file = path.join(root, "fixture.ts");
    try {
        await writeFile(
            file,
            `const mode = process.argv[2];
if (mode === "image") process.stdout.write(Buffer.from("${image().toString("base64")}", "base64"));
else if (mode === "overflow") process.stdout.write(Buffer.alloc(4 * 1024 * 1024));
else if (mode === "error") { process.stderr.write("private output"); process.exit(1); }
else setInterval(() => {}, 1000);`
        );
        const run = createCaptureRunner({
            command: process.execPath,
            cwd: root,
            environment: {},
            prefix: ["--no-env-file", file],
        });
        const output = await run(["image"], signal());
        expect(output.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        for (const mode of ["overflow", "error"])
            await rejects(run([mode], signal()), {
                message: "Window capture helper did not finish cleanly.",
            });
        await rejects(run(["hang"], AbortSignal.timeout(50)), {
            message: "Window capture helper did not finish cleanly.",
        });
        await rejects(run(["hang"], signal()), {
            message: "Window capture helper did not finish cleanly.",
        });
        expect(() =>
            createCaptureRunner({ command: "relative", cwd: root, environment: {} })
        ).toThrow(/absolute/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}, 10_000);
