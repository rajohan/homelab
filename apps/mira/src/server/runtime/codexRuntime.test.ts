import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { CodexRuntime } from "./codexRuntime";
import {
    disabledRuntimeFeatures,
    parsePilotConfig,
    pilotArguments,
    pilotEnvironment,
} from "./configuration";
import { RpcProcess } from "./rpcProcess";

const fixture = fileURLToPath(new URL("../testing/runtimeChild.ts", import.meta.url));
const options = (mode = "ok") => ({
    command: process.execPath,
    args: [fixture, mode],
    cwd: process.cwd(),
    env: {
        CODEX_HOME: process.cwd(),
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
    },
    requestTimeoutMs: 1000,
});

describe("Mira runtime transport", () => {
    test.each([
        "configured-mcp",
        "project-docs",
        "wrong-home",
        "web-search",
        "keyring",
        "configured-provider",
        "custom-endpoint",
        ...disabledRuntimeFeatures.map((feature) => `feature:${feature}`),
    ])("rejects effective %s configuration before any thread starts", async (mode) => {
        await rejects(CodexRuntime.connect(options(mode)));
    });
    test.each(["thread-provider", "resume-provider"])(
        "rejects the actual provider for %s before inference",
        async (mode) => {
            const runtime = await CodexRuntime.connect(options(mode));
            try {
                if (mode === "thread-provider")
                    await rejects(runtime.startThread("synthetic", process.cwd(), []));
                else {
                    const thread = await runtime.startThread(
                        "synthetic",
                        process.cwd(),
                        []
                    );
                    await rejects(runtime.resumeThread(thread, []));
                }
            } finally {
                await runtime.close();
            }
        }
    );
    test.each(["tool-ok", "tool-unknown", "tool-other-thread", "approval"])(
        "enforces host authority for %s",
        async (mode) => {
            const runtime = await CodexRuntime.connect(options(mode));
            let calls = 0;
            try {
                const thread = await runtime.startThread("synthetic", process.cwd(), [
                    {
                        name: "echo",
                        description: "Synthetic tool",
                        inputSchema: {},
                        execute: () => {
                            calls++;
                            return Promise.resolve("verified");
                        },
                    },
                ]);
                const result = await runtime.turn(thread, "test");
                expect(calls).toBe(mode === "tool-ok" ? 1 : 0);
                const expected: Record<string, string> = {
                    "tool-ok": "verified",
                    approval: "decline",
                };
                expect(result.text).toContain(expected[mode] ?? "not authorized");
            } finally {
                await runtime.close();
            }
        }
    );

    test("initializes, sanitizes account data and handles completion before the start response", async () => {
        const runtime = await CodexRuntime.connect(options());
        try {
            expect(await runtime.account()).toEqual({
                authenticated: true,
                plan: "plus",
            });
            expect(await runtime.models()).toEqual([
                { model: "synthetic", isDefault: true },
            ]);
            const thread = await runtime.startThread("synthetic", process.cwd(), []);
            expect(await runtime.turn(thread, "test")).toEqual({
                id: "turn-1",
                status: "completed",
                text: "Synthetic response",
            });
            await runtime.resumeThread(thread, []);
            const next = await runtime.turn(thread, "next");
            expect(next.id).toBe("turn-2");
        } finally {
            await runtime.close();
        }
    });

    test("does not report failed turns as success", async () => {
        const runtime = await CodexRuntime.connect(options("failed"));
        try {
            const thread = await runtime.startThread("synthetic", process.cwd(), []);
            const result = await runtime.turn(thread, "test");
            expect(result.status).toBe("failed");
        } finally {
            await runtime.close();
        }
    });

    test("cancels a turn, excludes concurrent turns and permits another run", async () => {
        const runtime = await CodexRuntime.connect(options("wait"));
        try {
            const thread = await runtime.startThread("synthetic", process.cwd(), []);
            const abort = new AbortController();
            const pending = runtime.turn(thread, "test", { signal: abort.signal });
            await rejects(runtime.turn(thread, "competing"), /active turn/);
            abort.abort();
            const cancelled = await pending;
            expect(cancelled.status).toBe("interrupted");
            const next = new AbortController();
            const resumed = runtime.turn(thread, "again", { signal: next.signal });
            next.abort();
            const second = await resumed;
            expect(second.status).toBe("interrupted");
        } finally {
            await runtime.close();
        }
    });

    test("closes a stalled turn without replaying it", async () => {
        const runtime = await CodexRuntime.connect(options("wait"));
        try {
            const thread = await runtime.startThread("synthetic", process.cwd(), []);
            await rejects(runtime.turn(thread, "test", { timeoutMs: 50 }), /deadline/);
            await rejects(runtime.account(), /closed/);
        } finally {
            await runtime.close();
        }
    });

    test.each(["malformed", "oversized", "timeout", "exit"])(
        "retires %s connections and rejects all waiters",
        async (mode) => {
            const connection = new RpcProcess({
                ...options(mode),
                maxFrameBytes: 2000,
                requestTimeoutMs: 100,
                onRequest: () => Promise.resolve({}),
            });
            try {
                const requests = await Promise.allSettled([
                    connection.request("one", {}),
                    connection.request("two", {}),
                ]);
                expect(requests.map((result) => result.status)).toEqual([
                    "rejected",
                    "rejected",
                ]);
                expect(connection.signal.aborted).toBe(true);
            } finally {
                await connection.close();
            }
        }
    );

    test("does not leak runtime diagnostics in request errors", async () => {
        const connection = new RpcProcess({
            ...options(),
            onRequest: () => Promise.resolve({}),
        });
        try {
            await connection.request("initialize", {});
            connection.notify("initialized", {});
            await rejects(connection.request("unknown", {}), {
                message: "Mira runtime rejected the request (-32001).",
            });
        } finally {
            await connection.close();
        }
    });
});

test("pilot configuration separates secrets, validates absolute paths and omits inherited tokens", () => {
    const root = process.platform === "win32" ? "C:/pilot" : "/pilot";
    const config = parsePilotConfig({
        command: `${root}/codex`,
        codexHome: `${root}/private`,
        workspace: `${root}/work`,
    });
    const environment = pilotEnvironment(config, {
        PATH: "runtime",
        OPENAI_API_KEY: "secret",
        GH_TOKEN: "secret",
        CODEX_HOME: "other",
    });
    expect(environment).toEqual({
        CODEX_HOME: `${root}/private`,
        HOME: `${root}/private`,
        USERPROFILE: `${root}/private`,
        PATH: "runtime",
    });
    expect(() =>
        parsePilotConfig({ ...config, workspace: `${root}/private/work` })
    ).toThrow("separate directories");
    expect(() => parsePilotConfig({ ...config, workspace: "relative" })).toThrow();
    expect(pilotArguments()).toContain("features.shell_tool=false");
    expect(pilotArguments()).toContain("project_doc_max_bytes=0");
    expect(pilotArguments()).toContain("stdio://");
});
