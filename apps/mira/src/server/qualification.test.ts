import { expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { Effect } from "effect";

import { qualifyRuntime } from "./qualification";
import { CodexRuntime } from "./runtime/codexRuntime";
import type { RuntimeTool } from "./runtime/protocol";

test.each([false, true])(
    "qualification proves the actual tool argument and returned receipt (corrupt=%s)",
    async (corrupt) => {
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
                            { marker: corrupt ? "corrupted" : nonce },
                            new AbortController().signal
                        )
                    );
                    options?.onDelta?.(receipt);
                    return { id: "one", status: "completed", text: receipt };
                }
                if (turn === 2) return { id: "two", status: "completed", text: receipt };
                if (turn === 3) {
                    await tools[1]!.execute({}, options!.signal!).catch(() => {});
                    return { id: "three", status: "interrupted", text: "" };
                }
                return { id: "four", status: "completed", text: "MIRA_READY" };
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
            if (corrupt) {
                await rejects(result);
                expect(turn).toBe(1);
                expect(closed).toBe(1);
            } else {
                expect(await result).toMatchObject({
                    tools: true,
                    processResume: true,
                    interruption: true,
                });
                expect(receipt).not.toBe(nonce);
                expect(closed).toBe(2);
            }
        } finally {
            connect.mockRestore();
        }
    }
);
