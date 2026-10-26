import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { computerEnvironment } from "../config/environment";
import { openComputerConsentSurface } from "./consentProcess";
import { computerWindowManifest } from "./policy";

async function fixture(mode: string) {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-local-consent-"));
    const child = path.join(directory, "host.ts");
    const record = path.join(directory, "record.json");
    const target = {
        executable: path.join(directory, "fixture.exe"),
        pid: 123,
        windowId: "456",
        delivery: "foreground" as const,
    };
    await writeFile(path.join(directory, ".env"), "SYNTHETIC_DOTENV=private\n");
    await writeFile(
        child,
        `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const target = ${JSON.stringify(target)};
const send = (value) => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
setInterval(() => {}, 1000);
process.on("SIGTERM", () => {});
process.stdin.on("end", () => { if (!mode.startsWith("hang")) process.exit(0); });
createInterface({ input: process.stdin }).on("line", (line) => {
 const message = JSON.parse(line);
 if (message.method === "initialize") {
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, input: message.params, unsafe: !!(process.env.SYNTHETIC_SECRET || process.env.SYNTHETIC_DOTENV || process.env.NODE_OPTIONS || process.env.COR_ENABLE_PROFILING) }));
  if (mode === "hang-init") return;
  send({ id: message.id, result: { protocol: mode === "bad-init" ? 2 : 1 } });
  if (mode === "decline" || mode === "late") { send({ method: "consent/stopped", params: {} }); if (mode === "late") send({ method: "consent/selected", params: { target } }); return; }
  if (mode === "no-selection") return;
  if (mode === "host-request") { send({ id: "forbidden", method: "shell", params: {} }); return; }
  if (mode === "oversized") { send({ method: "consent/selected", params: { padding: "private".repeat(2000) } }); return; }
  send({ method: "consent/selected", params: { target: mode === "widen" ? { ...target, mode: "control" } : target } });
  if (mode === "duplicate") send({ method: "consent/selected", params: { target } });
 } else {
  if (mode === "hang-check") return;
  send({ id: message.id, result: { ready: mode !== "not-ready" } });
 }
});
`
    );
    const stop = new AbortController();
    return {
        directory,
        target,
        stop,
        options: {
            command: process.execPath,
            windowsHide: true,
            args: ["--no-env-file", child],
            cwd: directory,
            environment: {
                ...computerEnvironment(),
                SYNTHETIC_SECRET: "private",
                NODE_OPTIONS: "--invalid",
                COR_ENABLE_PROFILING: "1",
            },
            origin: "https://computer.example.test",
            signal: stop.signal,
            request: {
                id: crypto.randomUUID(),
                computerId: crypto.randomUUID(),
                runId: crypto.randomUUID(),
                mode: "view" as const,
                state: "pending" as const,
                consentExpiresAt: new Date(Date.now() + 30_000).toISOString(),
                expiresAt: new Date(Date.now() + 120_000).toISOString(),
            },
        },
        record: async () =>
            (await Bun.file(record).json()) as {
                pid: number;
                input: Record<string, unknown>;
                unsafe: boolean;
            },
        initialized: async () => {
            const until = performance.now() + 2000;
            while (!(await Bun.file(record).exists())) {
                if (performance.now() >= until)
                    throw new Error("Fixture did not initialize.");
                await Bun.sleep(1);
            }
        },
        remove: () => rm(directory, { recursive: true, force: true }),
    };
}

test.each(["view", "control"] as const)(
    "a real private child preserves the trusted %s scope through the native manifest and returns an immutable target",
    async (mode) => {
        const f = await fixture("normal");
        try {
            const options = { ...f.options, request: { ...f.options.request, mode } };
            const opening = openComputerConsentSurface(options);
            // Later caller mutation must not rewrite the consent already sent to the local host.
            options.request.mode = mode === "view" ? "control" : "view";
            const surface = await opening;
            if (!surface) throw new Error("Expected synthetic consent.");
            expect(surface.target).toEqual({ ...f.target, mode });
            expect(computerWindowManifest(surface.target).allow.tools).toEqual(
                mode === "view"
                    ? ["get_window_state"]
                    : ["get_window_state", "click", "type_text"]
            );
            expect(Object.isFrozen(surface.target)).toBe(true);
            await surface.assertReady();
            const record = await f.record();
            expect(record.unsafe).toBe(false);
            expect(record.input).toEqual({
                id: f.options.request.id,
                runId: f.options.request.runId,
                origin: f.options.origin,
                mode,
                consentExpiresAt: f.options.request.consentExpiresAt,
                expiresAt: f.options.request.expiresAt,
            });
            await surface.close();
            expect(surface.signal.aborted).toBe(true);
            expect(() => process.kill(record.pid, 0)).toThrow();
            await rejects(surface.assertReady(), /no longer available/);
        } finally {
            f.stop.abort();
            await f.remove();
        }
    }
);

test("local rejection, connection cancellation and late selections never yield a target", async () => {
    for (const mode of ["decline", "late", "no-selection"]) {
        const f = await fixture(mode);
        try {
            const pending = openComputerConsentSurface(f.options).catch(() => null);
            if (mode === "no-selection") {
                await f.initialized();
                f.stop.abort();
            }
            expect(await pending).toBeNull();
            const record = await f.record();
            expect(() => process.kill(record.pid, 0)).toThrow();
        } finally {
            f.stop.abort();
            await f.remove();
        }
    }
});

test("invalid protocol, scope widening, duplicate selection and host-tool requests retire the child", async () => {
    for (const mode of [
        "bad-init",
        "widen",
        "duplicate",
        "host-request",
        "oversized",
        "not-ready",
    ]) {
        const f = await fixture(mode);
        try {
            const result = await openComputerConsentSurface(f.options).catch(() => null);
            expect(result).toBeNull();
            const record = await f.record();
            expect(() => process.kill(record.pid, 0)).toThrow();
        } finally {
            f.stop.abort();
            await f.remove();
        }
    }
});

test("hung native initialization and readiness are forcibly reaped without returning a stale target", async () => {
    for (const mode of ["hang-init", "hang-check"]) {
        const f = await fixture(mode);
        try {
            const result = await openComputerConsentSurface(f.options).catch(() => null);
            expect(result).toBeNull();
            const record = await f.record();
            expect(() => process.kill(record.pid, 0)).toThrow();
        } finally {
            f.stop.abort();
            await f.remove();
        }
    }
}, 15_000);

test("invalid origins, relative launch paths and expired consent cannot launch a local UI", async () => {
    const f = await fixture("normal");
    try {
        await rejects(
            openComputerConsentSurface({ ...f.options, command: "relative" }),
            /absolute paths/
        );
        await rejects(
            openComputerConsentSurface({
                ...f.options,
                origin: "http://computer.example.test",
            }),
            /HTTPS/
        );
        await rejects(
            openComputerConsentSurface({
                ...f.options,
                request: {
                    ...f.options.request,
                    consentExpiresAt: "2000-01-01T00:00:00.000Z",
                },
            }),
            /expired/
        );
    } finally {
        await f.remove();
    }
});
