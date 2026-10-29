import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { computerEnvironment } from "../config/environment";
import { createVisualChallenge } from "../testing/visualChallenge";
import { computerChildEnvironment, openComputerProcess } from "./process";
import { ComputerWindowSession } from "./session";

const signal = () => new AbortController().signal;
const grant = {
    executable: "/synthetic/app",
    pid: 123,
    windowId: "10",
    delivery: "foreground",
};
async function fixture(mode: string) {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-computer-process-test-"));
    const entrypoint = path.join(directory, "child.ts");
    const record = path.join(directory, "record.json");
    const data = createVisualChallenge().data;
    await writeFile(path.join(directory, ".env"), "SYNTHETIC_DOTENV=must-not-load\n");
    await writeFile(
        entrypoint,
        `
import { serveComputerChild } from ${JSON.stringify(new URL("child.ts", import.meta.url).href)};
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const mode = ${JSON.stringify(mode)};
let inputs = 0;
const record = () => writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, temporary: tmpdir(), inputs, unsafe: !!(process.env.SYNTHETIC_SECRET || process.env.SYNTHETIC_DOTENV || process.env.NODE_OPTIONS || process.env.BUN_OPTIONS) }));
record();
process.on("SIGTERM", () => {});
const never = () => new Promise(() => {});
const port = {
 observe: () => mode === "hang-read" ? never() : Promise.resolve(mode === "invalid" ? { filename: "/private/image.png" } : { snapshot: "synthetic", elements: [{ token: "s00000001:1", role: "button", label: "Synthetic button" }], coordinateInput: true, width: mode === "wrong-dimensions" ? 400 : 390, height: 110, content: { content: [{ type: "image", mediaType: "image/png", data: ${JSON.stringify(data)} }] } }),
 click: () => Promise.resolve({ effect: "unverified" }),
 clickElement: (token) => { inputs++; record(); return Promise.resolve({ effect: token === "s00000001:1" ? "confirmed" : "refused" }); },
 type: () => { inputs++; record(); if (mode === "exit") process.exit(4); return mode === "hang-input" ? never() : Promise.resolve({ effect: "confirmed" }); },
 close: () => Promise.resolve(),
};
if (mode === "bad-handshake") { process.stdin.on("data", () => process.stdout.write(JSON.stringify({ id: 1, result: { version: 99, driver: "0.37.0" } }) + "\\n")); }
else await serveComputerChild(process.stdin, process.stdout, () => mode === "hang-init" ? never() : Promise.resolve(port));
`
    );
    return {
        directory,
        entrypoint,
        options: {
            entrypoint,
            cwd: directory,
            environment: {
                ...computerEnvironment(),
                SYNTHETIC_SECRET: "must-not-forward",
                NODE_OPTIONS: "--invalid-flag",
                BUN_OPTIONS: "--invalid-flag",
            },
            signal: signal(),
            requestTimeoutMs: 1500,
        },
        record: async () =>
            (await Bun.file(record).json()) as {
                pid: number;
                temporary: string;
                inputs: number;
                unsafe: boolean;
            },
        remove: () => rm(directory, { recursive: true, force: true }),
    };
}
async function assertReaped(f: Awaited<ReturnType<typeof fixture>>) {
    const recorded = await f.record();
    expect(() => process.kill(recorded.pid, 0)).toThrow();
    expect(await Bun.file(path.join(recorded.temporary, "retained.json")).exists()).toBe(
        false
    );
    expect(existsSync(recorded.temporary)).toBe(false);
}

test("computer environment omits tokens, preload flags and arbitrary host settings", () => {
    expect(
        computerChildEnvironment({
            PATH: "/bin",
            HOME: "/user",
            DISPLAY: ":99",
            SystemRoot: String.raw`C:\Windows`,
            XAUTHORITY: "/display-cookie",
            GH_TOKEN: "secret",
            OPENAI_API_KEY: "secret",
            HOMELAB_DASHBOARD_DATABASE_URL: "secret",
            NODE_OPTIONS: "secret",
            LD_PRELOAD: "secret",
            BUN_OPTIONS: "secret",
            OTHER: "secret",
            TMP: undefined,
        })
    ).toEqual({
        PATH: "/bin",
        HOME: "/user",
        DISPLAY: ":99",
        SystemRoot: String.raw`C:\Windows`,
        XAUTHORITY: "/display-cookie",
    });
});

test("a real child returns images and effects without loading dotenv or inheriting credentials", async () => {
    const f = await fixture("normal");
    const port = await openComputerProcess(grant, f.options);
    const session = new ComputerWindowSession(port, () => Promise.resolve());
    try {
        const frame = await session.observe(signal());
        expect(frame.content).toHaveLength(1);
        expect(
            await session.act(
                { action: "type", observationId: frame.observationId, text: "once" },
                signal()
            )
        ).toEqual({ effect: "confirmed" });
        const next = await session.observe(signal());
        expect(
            await session.act(
                { action: "click", observationId: next.observationId, x: 3, y: 4 },
                signal()
            )
        ).toEqual({ effect: "unverified" });
        const elementFrame = await session.observe(signal());
        expect(elementFrame.elements?.[0]?.label).toBe("Synthetic button");
        expect(
            await session.act(
                {
                    action: "click_element",
                    observationId: elementFrame.observationId,
                    elementToken: "s00000001:1",
                },
                signal()
            )
        ).toEqual({ effect: "confirmed" });
        const recorded = await f.record();
        expect(recorded.inputs).toBe(2);
        expect(recorded.unsafe).toBe(false);
        await session.close();
        await session.close();
        await assertReaped(f);
    } finally {
        await session.close();
        await f.remove();
    }
});

test("a hung delivered input is killed, reaped and never replayed", async () => {
    const f = await fixture("hang-input");
    const port = await openComputerProcess(grant, f.options);
    const session = new ComputerWindowSession(port, () => Promise.resolve());
    try {
        const frame = await session.observe(signal());
        const started = performance.now();
        expect(
            await session.act(
                { action: "type", observationId: frame.observationId, text: "once" },
                signal()
            )
        ).toEqual({ effect: "unknown" });
        expect(performance.now() - started).toBeLessThan(4500);
        const recorded = await f.record();
        expect(recorded.inputs).toBe(1);
        await assert.rejects(session.observe(signal()), /stopped/);
        await assertReaped(f);
    } finally {
        await session.close();
        await f.remove();
    }
}, 10_000);

test("host cancellation interrupts a stuck observation and waits for process exit", async () => {
    const f = await fixture("hang-read");
    const host = new AbortController();
    const port = await openComputerProcess(grant, {
        ...f.options,
        signal: host.signal,
        requestTimeoutMs: 10_000,
    });
    try {
        const read = port.observe(signal());
        const rejected = assert.rejects(read, /unknown/);
        await Bun.sleep(50);
        host.abort();
        await rejected;
        await port.close();
        await assertReaped(f);
    } finally {
        await port.close();
        await f.remove();
    }
}, 10_000);

test("operation cancellation retires the child and unexpected EOF is an unknown input", async () => {
    for (const mode of ["normal", "exit"]) {
        const f = await fixture(mode);
        const port = await openComputerProcess(grant, f.options);
        const session = new ComputerWindowSession(port, () => Promise.resolve());
        try {
            const frame = await session.observe(signal());
            if (mode === "exit") {
                expect(
                    await session.act(
                        {
                            action: "type",
                            observationId: frame.observationId,
                            text: "once",
                        },
                        signal()
                    )
                ).toEqual({ effect: "unknown" });
                const recorded = await f.record();
                expect(recorded.inputs).toBe(1);
            } else {
                const abort = new AbortController();
                const pending = port.observe(abort.signal);
                abort.abort();
                await assert.rejects(pending);
            }
            await port.close();
            await assertReaped(f);
        } finally {
            await session.close();
            await f.remove();
        }
    }
}, 10_000);

test("invalid responses and failed or stuck initialization retire all native authority", async () => {
    for (const mode of ["invalid", "wrong-dimensions", "bad-handshake", "hang-init"]) {
        const f = await fixture(mode);
        try {
            if (mode === "invalid" || mode === "wrong-dimensions") {
                const port = await openComputerProcess(grant, f.options);
                await assert.rejects(port.observe(signal()), /valid result/);
                await port.close();
            } else
                await assert.rejects(openComputerProcess(grant, f.options), /initialize/);
            await assertReaped(f);
        } finally {
            await f.remove();
        }
    }
}, 15_000);

test("invalid host launch configuration or an already cancelled host cannot start a worker", async () => {
    const f = await fixture("normal");
    try {
        for (const options of [
            { entrypoint: "relative.ts" },
            { cwd: "." },
            { requestTimeoutMs: 0 },
            { requestTimeoutMs: 10_001 },
            { signal: AbortSignal.abort() },
        ])
            await assert.rejects(
                openComputerProcess(grant, { ...f.options, ...options })
            );
        expect(await Bun.file(path.join(f.directory, "record.json")).exists()).toBe(
            false
        );
    } finally {
        await f.remove();
    }
});

test("a parent disappearing during stuck native input triggers the child's own exit deadline", async () => {
    const f = await fixture("hang-input");
    const child = Bun.spawn([process.execPath, "--no-env-file", f.entrypoint], {
        cwd: f.directory,
        env: computerChildEnvironment(f.options.environment),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
    });
    try {
        await child.stdin.write(
            JSON.stringify({ id: 1, method: "initialize", params: grant }) + "\n"
        );
        const reader = child.stdout.getReader();
        const ready = await reader.read();
        expect(ready.done).toBe(false);
        reader.releaseLock();
        await child.stdin.write(
            JSON.stringify({ id: 2, method: "type", params: { text: "once" } }) + "\n"
        );
        let recorded = await f.record();
        for (let attempt = 0; attempt < 100 && recorded.inputs === 0; attempt++) {
            await Bun.sleep(5);
            recorded = await f.record();
        }
        expect(recorded.inputs).toBe(1);
        const started = performance.now();
        await child.stdin.end();
        await child.exited;
        expect(performance.now() - started).toBeLessThan(3000);
        expect(() => process.kill(recorded.pid, 0)).toThrow();
    } finally {
        child.kill();
        await child.exited;
        await f.remove();
    }
}, 10_000);
