import { Effect } from "effect";
import * as v from "valibot";

import { runtimeEnvironment } from "./config/environment";
import { CodexRuntime } from "./runtime/codexRuntime";
import { pilotArguments, type PilotConfig } from "./runtime/configuration";
import type { RuntimeTool } from "./runtime/protocol";
import type { RuntimeToolResult } from "./runtime/toolResult";
import { createMiraToolRouter } from "./runtime/toolRouter";
import { createVisualChallenge } from "./testing/visualChallenge";

/**
 * Qualify actual image tool output using only fresh synthetic pixels and the dedicated login.
 * @param config - Validated isolated runtime configuration; never production conversation data.
 * @param progress - Receives fixed, content-free qualification milestones.
 * @returns An Effect that requires two visually read answers through the normal tool router.
 */
export function qualifyVisualRuntime(
    config: PilotConfig,
    progress: (message: string) => void
) {
    return Effect.tryPromise(async () => {
        const runtime = await CodexRuntime.connect({
            command: config.command,
            args: pilotArguments(),
            cwd: config.workspace,
            env: runtimeEnvironment(config),
        });
        let threadId: string | null = null;
        let challenge = createVisualChallenge();
        let calls = 0;
        const tool: RuntimeTool<RuntimeToolResult> = {
            name: "mira_qualification_image",
            description:
                "Return a fresh synthetic image containing six digits. Read those digits from the image. This tool has no external effects or computer access.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: (input, signal) => {
                signal.throwIfAborted();
                v.parse(v.strictObject({}), input);
                calls++;
                return Promise.resolve({
                    content: [
                        { type: "text", text: "Read the six digits in this image." },
                        { type: "image", mediaType: "image/png", data: challenge.data },
                    ],
                });
            },
        };
        try {
            const account = await runtime.account();
            if (!account.authenticated)
                throw new Error("Visual qualification needs Mira's own ChatGPT login.");
            const models = await runtime.models();
            const model = config.model ?? models.find((entry) => entry.isDefault)?.model;
            if (
                !model ||
                !models.some(
                    (entry) =>
                        entry.model === model && entry.inputModalities.includes("image")
                )
            )
                throw new Error("The selected model does not advertise image input.");
            threadId = await runtime.startThread(
                model,
                config.workspace,
                createMiraToolRouter([tool]),
                "You are Mira in an isolated synthetic visual test. Use only the supplied host qualification tools and the runtime code-mode helpers. Read inline images visually after displaying them with the image helper. Do not open filesystem paths, browse websites, execute shell commands or access other services."
            );
            for (let attempt = 0; attempt < 2; attempt++) {
                const previous = challenge.answer;
                do challenge = createVisualChallenge();
                while (challenge.answer === previous);
                const result = await runtime.turn(
                    threadId,
                    "Discover the available tools. Use mira_tool_call to invoke mira_qualification_image exactly once. The returned value is a string containing a caption followed by a newline and an image data URL. In code mode, split that string on newlines and pass the complete line starting with data:image/ to image(); do not pass the caption or the whole mixed string. Then read the NEW six digits from that image and reply with only those digits. Do not use earlier answers, print encoded image bytes or access other services.",
                    { timeoutMs: 90_000 }
                );
                const finalLine = result.text.trim().split(/\r?\n/u).at(-1)?.trim();
                const answerMatched =
                    finalLine === challenge.answer &&
                    (result.text.match(/\b[0-9]{6}\b/gu)?.length ?? 0) === 1;
                if (
                    result.status !== "completed" ||
                    !answerMatched ||
                    calls !== attempt + 1
                )
                    throw new Error(
                        `Mira visual tool qualification did not pass (turn=${result.status}, toolCalls=${calls}, expectedCalls=${attempt + 1}, imageAnswerMatched=${answerMatched}).`
                    );
                progress(
                    "Read a fresh synthetic image returned through Mira's tool router."
                );
            }
            return { model, imageToolOutput: true, router: true, freshImages: 2 };
        } finally {
            // Retire the connection first; deletion requires a fresh connection with no registered thread.
            await runtime.close();
            if (threadId) {
                const cleanup = await CodexRuntime.connect({
                    command: config.command,
                    args: pilotArguments(),
                    cwd: config.workspace,
                    env: runtimeEnvironment(config),
                });
                try {
                    await cleanup.deleteThread(threadId);
                } finally {
                    await cleanup.close();
                }
            }
        }
    });
}
