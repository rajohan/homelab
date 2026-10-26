import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createVisualChallenge } from "../testing/visualChallenge";
import { CodexRuntime } from "./codexRuntime";
import type { RuntimeTool } from "./protocol";
import type { RuntimeToolResult } from "./toolResult";
import { createMiraToolRouter } from "./toolRouter";

const options = (mode: string) => ({
    command: process.execPath,
    args: [fileURLToPath(new URL("../testing/runtimeChild.ts", import.meta.url)), mode],
    cwd: process.cwd(),
    env: {
        CODEX_HOME: process.cwd(),
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
    },
    requestTimeoutMs: 1000,
});
const call = { callId: "synthetic", threadId: "synthetic", turnId: "synthetic" };

test.each(["tool-ok", "tool-router"])(
    "delivers real structured image content through %s",
    async (mode) => {
        const data = createVisualChallenge().data;
        let calls = 0;
        const tool: RuntimeTool<RuntimeToolResult> = {
            name: "echo",
            description: "Synthetic visual tool",
            inputSchema: {},
            execute: () => {
                calls++;
                return Promise.resolve({
                    content: [
                        { type: "text", text: "Current image" },
                        { type: "image", mediaType: "image/png", data },
                    ],
                });
            },
        };
        const runtime = await CodexRuntime.connect(options(mode));
        try {
            const thread = await runtime.startThread(
                "synthetic",
                process.cwd(),
                mode === "tool-router" ? createMiraToolRouter([tool]) : [tool]
            );
            const result = await runtime.turn(thread, "Read image");
            expect(calls).toBe(1);
            expect(JSON.parse(result.text)).toEqual({
                success: true,
                contentItems: [
                    { type: "inputText", text: "Current image" },
                    { type: "inputImage", imageUrl: `data:image/png;base64,${data}` },
                ],
            });
        } finally {
            await runtime.close();
        }
    }
);

test("invalid image output produces a fixed error without leaking its content", async () => {
    const runtime = await CodexRuntime.connect(options("tool-ok"));
    try {
        const thread = await runtime.startThread("synthetic", process.cwd(), [
            {
                name: "echo",
                description: "Invalid image",
                inputSchema: {},
                execute: () =>
                    Promise.resolve({
                        content: [
                            {
                                type: "image",
                                mediaType: "image/png",
                                data: "private-invalid-bytes",
                            },
                        ],
                    }),
            },
        ]);
        const result = await runtime.turn(thread, "Read image");
        expect(JSON.parse(result.text)).toEqual({
            success: false,
            contentItems: [{ type: "inputText", text: "Mira tool did not complete." }],
        });
        expect(result.text).not.toContain("private-invalid-bytes");
    } finally {
        await runtime.close();
    }
});

test("router preserves cancellation and does not admit a visual tool after abort", () => {
    let calls = 0;
    const [list, invoke] = createMiraToolRouter<RuntimeToolResult>([
        {
            name: "screen",
            description: "Synthetic image",
            inputSchema: {},
            execute: () => {
                calls++;
                return Promise.resolve({
                    content: [{ type: "text", text: "Unreachable" }],
                });
            },
        },
    ]);
    const abort = new AbortController();
    abort.abort();
    expect(() => list!.execute({}, abort.signal, call)).toThrow();
    expect(() =>
        invoke!.execute({ name: "screen", arguments: {} }, abort.signal, call)
    ).toThrow();
    expect(calls).toBe(0);
});

test("runtime rejects a visual result when its tool loses authority before returning", async () => {
    const runtime = await CodexRuntime.connect(options("tool-ok"));
    const abort = new AbortController();
    const returned = Promise.withResolvers<void>();
    try {
        const thread = await runtime.startThread("synthetic", process.cwd(), [
            {
                name: "echo",
                description: "Synthetic cancelled screenshot",
                inputSchema: {},
                execute: () => {
                    abort.abort();
                    returned.resolve();
                    return Promise.resolve({
                        content: [
                            {
                                type: "image",
                                mediaType: "image/png",
                                data: createVisualChallenge().data,
                            },
                        ],
                    });
                },
            },
        ]);
        const result = await runtime.turn(thread, "Read image", { signal: abort.signal });
        await returned.promise;
        expect(result.status).toBe("interrupted");
        expect(result.text).not.toContain("inputImage");
        expect(result.text).not.toContain("data:image");
    } finally {
        await runtime.close();
    }
});
