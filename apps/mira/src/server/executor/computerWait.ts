import { setTimeout as delay } from "node:timers/promises";

import * as v from "valibot";

import { inviteMiraComputer } from "../data/computerAccess";
import { readMiraComputerReadiness } from "../data/computerWait";
import { MiraFailure } from "../data/context";
import type { MiraToolDefinition } from "./toolDefinition";

const schema = v.strictObject({
    requestMode: v.exactOptional(v.picklist(["view", "control"])),
    waitSeconds: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(60)),
        60
    ),
});

/**
 * Keep an explicitly requested manual computer workflow alive while the operator decides.
 * @returns Readiness for the current run, optionally inviting one local approval.
 */
export function createMiraComputerWaitTool(): MiraToolDefinition {
    return {
        name: "mira_computer_wait",
        automatic: false,
        commitsIndependently: true,
        description:
            "When the operator asks you to use their Windows PC, call this tool with requestMode=view to look, or control if the requested work requires clicks or typing, and waitSeconds=0. This asks the connected PC once for local approval covering its displays. Existing consent is reused. You cannot approve your own request. If pending, wait up to 60 seconds with no requestMode and keep the run alive while they decide. If chooseComputer, ask them to open Computer access in Chat and choose the PC or a single window. If stopped or declined, respect their decision. A read without requestMode never sends a prompt. Once ready, use only the reported mode and scope. After completing computer work use mira_live_assistance_finish.",
        inputSchema: {
            type: "object",
            properties: {
                requestMode: { type: "string", enum: ["view", "control"] },
                waitSeconds: { type: "integer", minimum: 0, maximum: 60 },
            },
            additionalProperties: false,
        },
        action: async (input, signal, context) => {
            const { waitSeconds, requestMode } = v.parse(schema, input);
            const deadline = performance.now() + waitSeconds * 1000;
            try {
                if (requestMode) {
                    signal.throwIfAborted();
                    const current = await readMiraComputerReadiness(context);
                    if (current.state === "waiting" || current.state === "offline") {
                        const outcome = await inviteMiraComputer(context, requestMode);
                        if (outcome === "choose")
                            return {
                                state:
                                    current.state === "offline"
                                        ? "offline"
                                        : "chooseComputer",
                            };
                        if (outcome === "existing") {
                            const previous = await readMiraComputerReadiness(context);
                            return previous.state === "ready" ||
                                previous.state === "pending"
                                ? previous
                                : { state: "stopped" };
                        }
                    }
                }
                for (;;) {
                    signal.throwIfAborted();
                    const status = await readMiraComputerReadiness(context);
                    signal.throwIfAborted();
                    if (
                        !["waiting", "pending"].includes(status.state) ||
                        performance.now() >= deadline
                    )
                        return status;
                    await delay(
                        Math.min(250, Math.max(1, deadline - performance.now())),
                        undefined,
                        { signal }
                    );
                }
            } catch (error) {
                if (
                    signal.aborted &&
                    (error === signal.reason ||
                        (error instanceof Error &&
                            error.name === "AbortError" &&
                            error.cause === signal.reason))
                )
                    throw new MiraFailure(
                        "CONFLICT",
                        "Waiting for local computer access was cancelled."
                    );
                throw error;
            }
        },
    };
}
