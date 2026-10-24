import { Effect } from "effect";
import * as v from "valibot";

import { runtimeEnvironment } from "./config/environment";
import { CodexRuntime } from "./runtime/codexRuntime";
import { pilotArguments, type PilotConfig } from "./runtime/configuration";
import type { RuntimeTool } from "./runtime/protocol";

function connect(config: PilotConfig): Promise<CodexRuntime> {
    return CodexRuntime.connect({
        command: config.command,
        args: pilotArguments(),
        cwd: config.workspace,
        env: runtimeEnvironment(config),
    });
}

/**
 * Exercise the real runtime with synthetic data and emit only content-free evidence.
 * @param config - Isolated directories and executable owned by the operator.
 * @param progress - Receives fixed milestones without prompts, tokens or account IDs.
 * @returns An Effect that checks authentication, tools, resume and cancellation.
 */
export function qualifyRuntime(config: PilotConfig, progress: (message: string) => void) {
    return Effect.tryPromise(async () => {
        let runtime = await connect(config);
        let echoCalls = 0;
        let deltas = 0;
        const nonce = crypto.randomUUID();
        const receipt = crypto.randomUUID();
        const interrupted = new AbortController();
        const tools: RuntimeTool[] = [
            {
                name: "mira_qualification_echo",
                description:
                    "Validate the supplied synthetic marker and return a separate receipt. This has no external effects.",
                inputSchema: {
                    type: "object",
                    properties: { marker: { type: "string" } },
                    required: ["marker"],
                    additionalProperties: false,
                },
                execute: (input) => {
                    v.parse(v.strictObject({ marker: v.literal(nonce) }), input);
                    echoCalls++;
                    return Promise.resolve(receipt);
                },
            },
            {
                name: "mira_qualification_wait",
                description:
                    "Wait for the host to cancel this synthetic test. No external effects.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                execute: async (input, signal) => {
                    v.parse(v.strictObject({}), input);
                    interrupted.abort();
                    await new Promise<void>((resolve) => {
                        if (signal.aborted) resolve();
                        else
                            signal.addEventListener("abort", () => resolve(), {
                                once: true,
                            });
                    });
                    signal.throwIfAborted();
                    return "Cancelled";
                },
            },
        ];
        try {
            const account = await runtime.account();
            if (!account.authenticated)
                throw new Error("Mira pilot needs its own ChatGPT login.");
            progress("Authenticated using the pilot's own ChatGPT profile.");
            const models = await runtime.models();
            const model = config.model ?? models.find((entry) => entry.isDefault)?.model;
            if (!model || !models.some((entry) => entry.model === model))
                throw new Error(
                    "No configured model is available in the runtime catalog."
                );
            const threadId = await runtime.startThread(model, config.workspace, tools);
            const first = await runtime.turn(
                threadId,
                `Call mira_qualification_echo with marker ${nonce}, then repeat the receipt returned by that tool exactly. Remember the returned receipt for the next turn.`,
                {
                    onDelta: () => {
                        deltas++;
                    },
                }
            );
            if (
                first.status !== "completed" ||
                echoCalls !== 1 ||
                !first.text.includes(receipt) ||
                deltas === 0
            )
                throw new Error("Mira streaming/tool qualification did not pass.");
            progress(
                "Completed model response, streamed text and a validated host tool call."
            );
            await runtime.close();
            runtime = await connect(config);
            await runtime.resumeThread(threadId, tools);
            const resumed = await runtime.turn(
                threadId,
                "Repeat the exact receipt from our previous turn. Do not call tools."
            );
            if (
                resumed.status !== "completed" ||
                resumed.text.trim() !== receipt ||
                echoCalls !== 1
            )
                throw new Error(
                    "Mira did not restore the conversation after process replacement."
                );
            progress(
                "Restored conversation context after replacing the runtime process."
            );
            const stopped = await runtime.turn(
                threadId,
                "Call mira_qualification_wait now, exactly once.",
                { signal: interrupted.signal }
            );
            if (stopped.status !== "interrupted" || !interrupted.signal.aborted)
                throw new Error("Mira interruption qualification did not pass.");
            progress(
                "Interrupted an active tool turn and observed the terminal interrupted status."
            );
            const recovered = await runtime.turn(
                threadId,
                "Reply with exactly MIRA_READY. Do not use tools."
            );
            if (
                recovered.status !== "completed" ||
                recovered.text.trim() !== "MIRA_READY"
            )
                throw new Error("Mira did not recover after interruption.");
            progress("Completed a new turn after interruption.");
            return {
                model,
                streaming: true,
                tools: true,
                processResume: true,
                interruption: true,
                recovery: true,
            };
        } finally {
            await runtime.close();
        }
    });
}
