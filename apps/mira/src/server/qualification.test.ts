import { expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { Effect } from "effect";

import { qualifyRuntime } from "./qualification";
import { CodexRuntime } from "./runtime/codexRuntime";
import type { RuntimeTool } from "./runtime/protocol";

test.each(["ok", "nonce", "resume-tool", "recovery-refusal"])(
    "qualification proves the actual tool argument and returned receipt (mode=%s)",
    async (mode) => {
        let tools: RuntimeTool[] = [];
        let turn = 0;
        let receipt = "";
        let nonce = "";
        let closed = 0;
        const fake = {
            account: () => Promise.resolve({ authenticated: true, plan: "synthetic" }),
            models: () => Promise.resolve([{ model: "synthetic", isDefault: true }]),
            startThread: (
                _model: string,
                _workspace: string,
                supplied: RuntimeTool[]
            ) => {
                tools = supplied;
                return Promise.resolve("synthetic-thread");
            },
            resumeThread: () => Promise.resolve(),
            turn: async (
                _id: string,
                text: string,
                options?: { onDelta?: (delta: string) => void; signal?: AbortSignal }
            ) => {
                turn++;
                if (turn === 1) {
                    nonce = /with marker ([a-f0-9-]+)/.exec(text)![1]!;
                    receipt = String(
                        await tools[0]!.execute(
                            { marker: mode === "nonce" ? "corrupted" : nonce },
                            new AbortController().signal
                        )
                    );
                    options?.onDelta?.(receipt);
                    return { id: "one", status: "completed", text: receipt };
                }
                if (turn === 2 && mode === "resume-tool")
                    await tools[0]!.execute(
                        { marker: nonce },
                        new AbortController().signal
                    );
                if (turn === 2) return { id: "two", status: "completed", text: receipt };
                if (turn === 3) {
                    await tools[1]!.execute({}, options!.signal!).catch(() => {});
                    return { id: "three", status: "interrupted", text: "" };
                }
                return {
                    id: "four",
                    status: "completed",
                    text:
                        mode === "recovery-refusal"
                            ? "Cannot comply; expected MIRA_READY"
                            : "MIRA_READY",
                };
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
            const result = Effect.runPromise(
                qualifyRuntime(
                    { command: "/synthetic", codexHome: "/private", workspace: "/empty" },
                    () => {}
                )
            );
            if (mode === "ok") {
                expect(await result).toMatchObject({
                    tools: true,
                    processResume: true,
                    interruption: true,
                });
                expect(receipt).not.toBe(nonce);
                expect(closed).toBe(2);
            } else {
                await rejects(result);
                const expectedTurn = mode === "resume-tool" ? 2 : 4;
                expect(turn).toBe(mode === "nonce" ? 1 : expectedTurn);
                expect(closed).toBe(mode === "nonce" ? 1 : 2);
            }
        } finally {
            connect.mockRestore();
        }
    }
);
