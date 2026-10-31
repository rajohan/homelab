import { describe, expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { fileURLToPath } from "node:url";

import type { MiraActivity } from "@homelab/contracts/mira";

import { CodexRuntime } from "./codexRuntime";
import {
    disabledRuntimeFeatures,
    enabledRuntimeFeatures,
    parsePilotConfig,
    pilotArguments,
    pilotEnvironment,
} from "./configuration";
import { RuntimeResponseError } from "./responseError";
import { RpcProcess } from "./rpcProcess";
import { createMiraToolRouter } from "./toolRouter";

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
    test.each(["steer-ok", "steer-error", "steer-wrong-receipt"])(
        "steering binds guidance and acknowledgements to the active turn: %s",
        async (mode) => {
            const runtime = await CodexRuntime.connect(options(mode));
            let pending: ReturnType<CodexRuntime["turn"]> | undefined;
            try {
                const thread = await runtime.startThread("synthetic", process.cwd(), []);
                expect(await runtime.steer(thread, "turn-1", "before starting")).toBe(
                    false
                );
                const started = Promise.withResolvers<string>();
                pending = runtime.turn(thread, "Work on the original task", {
                    onStarted: (id) => {
                        started.resolve(id);
                        return Promise.resolve();
                    },
                });
                const turnId = await started.promise;
                expect(
                    await runtime.steer("another-thread", turnId, "wrong thread")
                ).toBe(false);
                expect(await runtime.steer(thread, "another-turn", "wrong turn")).toBe(
                    false
                );
                if (mode === "steer-ok") {
                    expect(
                        await runtime.steer(
                            thread,
                            turnId,
                            "Use the updated completion criteria"
                        )
                    ).toBe(true);
                    const result = await pending;
                    expect(result.id).toBe(turnId);
                    expect(JSON.parse(result.text)).toEqual([
                        {
                            type: "text",
                            text: "Use the updated completion criteria",
                            text_elements: [],
                        },
                    ]);
                    expect(await runtime.steer(thread, turnId, "after completion")).toBe(
                        false
                    );
                } else {
                    await rejects(runtime.steer(thread, turnId, "Update the task"));
                    await runtime.interrupt();
                    const result = await pending;
                    expect(result.status).toBe("interrupted");
                }
            } finally {
                await runtime.close();
                await Promise.allSettled([pending]);
            }
        }
    );
    test("separates message items while preserving streamed Markdown and turn boundaries", async () => {
        const runtime = await CodexRuntime.connect(options("message-boundaries"));
        try {
            const thread = await runtime.startThread("synthetic", process.cwd(), []);
            for (const text of ["first", "next"]) {
                const chunks: string[] = [];
                const result = await runtime.turn(thread, text, {
                    onDelta: (delta) => chunks.push(delta),
                });
                expect(result.text).toBe(
                    'Creating the file.\n\nCreated.\n\n```json\n{\n  "ok": true\n}\n```'
                );
                expect(chunks).toEqual([
                    "Creating ",
                    "the file.",
                    "\n\nCreated.\n\n```json\n{",
                    '\n  "ok": true\n}\n```',
                ]);
                expect(chunks.join("")).toBe(result.text);
            }
        } finally {
            await runtime.close();
        }
    });
    test.each(["same-item", "new-item"])(
        "includes message separators in the output limit for %s",
        async (suffix) => {
            const runtime = await CodexRuntime.connect(
                options(`message-limit-${suffix}`)
            );
            const chunks: string[] = [];
            try {
                const thread = await runtime.startThread("synthetic", process.cwd(), []);
                const turn = runtime.turn(thread, "test", {
                    onDelta: (delta) => chunks.push(delta),
                });
                if (suffix === "same-item") {
                    const result = await turn;
                    expect(result.text).toHaveLength(256_000);
                    expect(result.text).toBe(chunks.join(""));
                } else {
                    await rejects(turn, /disconnected/);
                    expect(chunks.join("")).toHaveLength(255_999);
                }
            } finally {
                await runtime.close();
            }
        }
    );

    test.each(["resume-missing", "resume-missing-other"])(
        "classifies only the exact missing resume reference for %s",
        async (mode) => {
            const runtime = await CodexRuntime.connect(options(mode));
            try {
                await rejects(
                    runtime.resumeThread("stored-thread", []),
                    (error: unknown) =>
                        error instanceof RuntimeResponseError &&
                        error.threadMissing === (mode === "resume-missing")
                );
            } finally {
                await runtime.close();
            }
        }
    );
    test.each(["ok", "delete-missing", "delete-other-error"])(
        "handles %s deletion receipts without concealing unrelated failures",
        async (mode) => {
            const runtime = await CodexRuntime.connect(options(mode));
            try {
                await (mode === "delete-other-error"
                    ? rejects(runtime.deleteThread("stored-thread"))
                    : runtime.deleteThread("stored-thread"));
                const thread = await runtime.startThread("synthetic", process.cwd(), []);
                await rejects(runtime.deleteThread(thread), /fresh runtime/);
            } finally {
                await runtime.close();
            }
        }
    );
    test("accepts the supported official built-in endpoint defaults", async () => {
        const runtime = await CodexRuntime.connect(options("official-endpoints"));
        await runtime.close();
    });
    test.each([
        ...enabledRuntimeFeatures.map((feature) => `required-feature:${feature}`),
        "admin-skill",
        "disabled-admin-skill",
        "outside-system-skill",
        "duplicate-skill",
        "missing-skill",
        "skill-discovery-error",
        ...[
            "openai_base_url",
            "chatgpt_base_url",
            "instructions",
            "developer_instructions",
            "model_instructions_file",
            "compact_prompt",
            "experimental_compact_prompt_file",
            "model_catalog_json",
            "notify",
            "otel",
            "experimental_thread_store",
            "experimental_thread_store_endpoint",
            "sqlite_home",
        ].map((key) => `override:${key}`),
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
    test.each([
        "thread-provider",
        "resume-provider",
        ...["cwd", "instructions", "approval", "sandbox", "network"].flatMap((field) => [
            `thread-${field}`,
            `resume-${field}`,
        ]),
    ])("rejects the actual provider for %s before inference", async (mode) => {
        const runtime = await CodexRuntime.connect(options(mode));
        try {
            if (mode.startsWith("thread-"))
                await rejects(runtime.startThread("synthetic", process.cwd(), []));
            else {
                const thread = await runtime.startThread("synthetic", process.cwd(), []);
                await rejects(runtime.resumeThread(thread, []));
            }
        } finally {
            await runtime.close();
        }
    });
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
            expect(await runtime.models()).toMatchObject([
                {
                    model: "synthetic",
                    isDefault: true,
                    supportedReasoningEfforts: [],
                    serviceTiers: [],
                },
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

    test("cancels a turn, retires the child and resumes through a fresh connection", async () => {
        const runtime = await CodexRuntime.connect(options("wait"));
        let resumed: CodexRuntime | undefined;
        try {
            const thread = await runtime.startThread("synthetic", process.cwd(), []);
            const abort = new AbortController();
            const pending = runtime.turn(thread, "test", { signal: abort.signal });
            await rejects(runtime.turn(thread, "competing"), /active turn/);
            abort.abort();
            const cancelled = await pending;
            expect(cancelled.status).toBe("interrupted");
            await rejects(runtime.turn(thread, "reuse retired child"), /closed/);
            resumed = await CodexRuntime.connect(options());
            await resumed.resumeThread(thread, []);
            const continued = await resumed.turn(thread, "continue");
            expect(continued.status).toBe("completed");
        } finally {
            await runtime.close();
            await resumed?.close();
        }
    });

    test("observes cancellation fired just before listener registration", async () => {
        const runtime = await CodexRuntime.connect(options("wait"));
        const abort = new AbortController();
        const subscribe = abort.signal.addEventListener.bind(abort.signal);
        const race = spyOn(abort.signal, "addEventListener").mockImplementation(
            (...args: Parameters<AbortSignal["addEventListener"]>) => {
                abort.abort();
                subscribe(...args);
            }
        );
        try {
            const thread = await runtime.startThread("synthetic", process.cwd(), []);
            const result = await runtime.turn(thread, "cancel", {
                signal: abort.signal,
                timeoutMs: 1000,
            });
            expect(result.status).toBe("interrupted");
        } finally {
            race.mockRestore();
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
        HOMELAB_MIRA_GITHUB_TOKEN: "dedicated-mira-secret",
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

test("each resumed turn receives explicit model settings and only its own activity events", async () => {
    const runtime = await CodexRuntime.connect(options("settings-activity"));
    const activity: MiraActivity[] = [];
    try {
        const thread = await runtime.startThread("synthetic", process.cwd(), []);
        const chosen = { model: "model-a", effort: "high", serviceTier: "priority" };
        const first = await runtime.turn(thread, "first", {
            settings: chosen,
            onActivity: (event) => activity.push(event),
        });
        expect(JSON.parse(first.text)).toEqual(chosen);
        expect(activity).toEqual([
            { phase: "thinking", tool: null },
            { phase: "replying", tool: null },
        ]);
        await runtime.resumeThread(thread, []);
        const defaults = { model: "model-b", effort: "low", serviceTier: null };
        const next = await runtime.turn(thread, "next", { settings: defaults });
        expect(JSON.parse(next.text)).toEqual(defaults);
    } finally {
        await runtime.close();
    }
});

test("stable tool declarations discover the current registry and preserve underlying call fencing", async () => {
    const seen: unknown[] = [];
    const first = createMiraToolRouter([
        {
            name: "mira_old",
            description: "Old registry",
            inputSchema: { type: "object" },
            execute: () => Promise.resolve("old"),
        },
    ]);
    const current = createMiraToolRouter([
        {
            name: "mira_new",
            description: "New registry",
            inputSchema: { type: "object", properties: { value: { type: "string" } } },
            execute: (input, _signal, call) => {
                seen.push({ input, call });
                return Promise.resolve("verified");
            },
        },
    ]);
    expect(
        current.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
        }))
    ).toEqual(
        first.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
        }))
    );
    const signal = new AbortController().signal;
    const call = {
        callId: "current-provider-call",
        threadId: "retained-thread",
        turnId: "new-turn",
    };
    const catalog = await current[0]!.execute({}, signal, call);
    expect(catalog).toContain("mira_new");
    expect(catalog).not.toContain("mira_old");
    expect(() =>
        current[1]!.execute({ name: "mira_old", arguments: {} }, signal, call)
    ).toThrow(/not available/);
    expect(
        await current[1]!.execute(
            { name: "mira_new", arguments: { value: "synthetic" } },
            signal,
            call
        )
    ).toBe("verified");
    expect(seen).toEqual([{ input: { value: "synthetic" }, call }]);
    const cancelled = AbortSignal.abort();
    expect(() => current[0]!.execute({}, cancelled, call)).toThrow();
});

test("resuming an existing conversation applies the current trusted server instructions", async () => {
    const runtime = await CodexRuntime.connect(options());
    const requests = spyOn(RpcProcess.prototype, "request");
    try {
        const thread = await runtime.startThread(
            "synthetic",
            process.cwd(),
            [],
            "Original server policy."
        );
        await runtime.resumeThread(
            thread,
            [],
            "Current server policy and tool discovery."
        );
        expect(
            requests.mock.calls.find(([method]) => method === "thread/resume")?.[1]
        ).toMatchObject({
            threadId: thread,
            developerInstructions: "Current server policy and tool discovery.",
            sandbox: "read-only",
            approvalPolicy: "untrusted",
        });
        const result = await runtime.turn(thread, "Continue");
        expect(result.status).toBe("completed");
    } finally {
        requests.mockRestore();
        await runtime.close();
    }
});

test("pre-router conversations retain current direct handlers when their provider catalog cannot change", async () => {
    const runtime = await CodexRuntime.connect(options("tool-ok"));
    let oldCalls = 0;
    let currentCalls = 0;
    try {
        const legacy = {
            name: "echo",
            description: "Legacy direct tool",
            inputSchema: {},
            execute: () => {
                oldCalls++;
                return Promise.resolve("old handler");
            },
        };
        const thread = await runtime.startThread("synthetic", process.cwd(), [legacy]);
        await runtime.resumeThread(
            thread,
            createMiraToolRouter(
                [
                    {
                        ...legacy,
                        execute: () => {
                            currentCalls++;
                            return Promise.resolve("current fenced handler");
                        },
                    },
                ],
                true
            ),
            "Use the supplied direct tools if discovery is not offered."
        );
        const result = await runtime.turn(thread, "Use the original direct echo tool");
        expect(result.text).toContain("current fenced handler");
        expect(currentCalls).toBe(1);
        expect(oldCalls).toBe(0);
        expect(createMiraToolRouter([legacy]).map((tool) => tool.name)).toEqual([
            "mira_tools_list",
            "mira_tool_call",
        ]);
    } finally {
        await runtime.close();
    }
});
