import { expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { Effect } from "effect";

import { CodexRuntime } from "./runtime/codexRuntime";
import type { RuntimeTool } from "./runtime/protocol";
import { runtimeContentItems, type RuntimeToolResult } from "./runtime/toolResult";
import * as challengeModule from "./testing/visualChallenge";
import { qualifyVisualRuntime } from "./visualQualification";

test.each([
    "ok",
    "commentary",
    "quoted-answer",
    "conflicting-answer",
    "wrong-answer",
    "missing-tool",
    "extra-tool",
    "text-only",
    "unauthenticated",
])("visual qualification requires fresh image answers and cleanup (%s)", async (mode) => {
    const original = challengeModule.createVisualChallenge;
    let answer = "";
    let tools: RuntimeTool<RuntimeToolResult>[] = [];
    let turns = 0;
    let closed = 0;
    let deleted = 0;
    const progress: string[] = [];
    const create = spyOn(challengeModule, "createVisualChallenge").mockImplementation(
        () => {
            const challenge = original();
            answer = challenge.answer;
            return challenge;
        }
    );
    const fake = {
        account: () =>
            Promise.resolve({
                authenticated: mode !== "unauthenticated",
                plan: "synthetic",
            }),
        models: () =>
            Promise.resolve([
                {
                    model: "synthetic",
                    isDefault: true,
                    inputModalities: mode === "text-only" ? ["text"] : ["text", "image"],
                },
            ]),
        startThread: (
            _model: string,
            _workspace: string,
            registered: RuntimeTool<RuntimeToolResult>[]
        ) => {
            tools = registered;
            return Promise.resolve("synthetic-visual-thread");
        },
        turn: async (_id: string, prompt: string) => {
            turns++;
            expect(prompt).not.toContain(answer);
            if (mode !== "missing-tool") {
                const invoke = tools.find((tool) => tool.name === "mira_tool_call")!;
                const input = { name: "mira_qualification_image", arguments: {} };
                const call = {
                    callId: "image",
                    threadId: "synthetic-visual-thread",
                    turnId: String(turns),
                };
                const result = await invoke.execute(
                    input,
                    new AbortController().signal,
                    call
                );
                const content = runtimeContentItems(result);
                expect(content[1]?.type).toBe("inputImage");
                expect(content[0]).toEqual({
                    type: "inputText",
                    text: "Read the six digits in this image.",
                });
                if (mode === "extra-tool")
                    await invoke.execute(input, new AbortController().signal, call);
            }
            return {
                id: String(turns),
                status: "completed",
                text:
                    (
                        {
                            "wrong-answer": "000000",
                            commentary: `Reading the synthetic image.\n${answer}`,
                            "quoted-answer": `Cannot read it; expected ${answer}`,
                            "conflicting-answer": `000000\n${answer}`,
                        } as Record<string, string>
                    )[mode] ?? answer,
            };
        },
        deleteThread: (id: string) => {
            expect(id).toBe("synthetic-visual-thread");
            deleted++;
            return Promise.resolve();
        },
        close: () => {
            closed++;
            return Promise.resolve();
        },
    };
    const connect = spyOn(CodexRuntime, "connect").mockResolvedValue(
        fake as unknown as CodexRuntime
    );
    try {
        const pending = Effect.runPromise(
            qualifyVisualRuntime(
                { command: "/synthetic", codexHome: "/private", workspace: "/empty" },
                (message) => progress.push(message)
            )
        );
        if (mode === "ok" || mode === "commentary") {
            expect(await pending).toEqual({
                model: "synthetic",
                imageToolOutput: true,
                router: true,
                freshImages: 2,
            });
            expect(turns).toBe(2);
            expect(progress).toHaveLength(2);
            expect(progress.join("\n")).not.toContain(answer);
        } else await rejects(pending);
        const started = mode !== "unauthenticated" && mode !== "text-only";
        expect(deleted).toBe(started ? 1 : 0);
        expect(closed).toBe(started ? 2 : 1);
    } finally {
        connect.mockRestore();
        create.mockRestore();
    }
});
