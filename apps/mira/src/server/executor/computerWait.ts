import { setTimeout as delay } from "node:timers/promises";

import * as v from "valibot";

import { readMiraComputerReadiness } from "../data/computerWait";
import { MiraFailure } from "../data/context";
import type { MiraToolDefinition } from "./toolDefinition";

const schema = v.strictObject({
    waitSeconds: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(60)),
        60
    ),
});

/**
 * Keep an explicitly requested manual computer workflow alive while the operator decides.
 * @returns A bounded read-only wait; it never requests access or opens a local consent prompt.
 */
export function createMiraComputerWaitTool(): MiraToolDefinition {
    return {
        name: "mira_computer_wait",
        automatic: false,
        description:
            "Check computer access for this manual run, or wait up to 60 seconds for the operator to grant it. Only use when the operator has asked for computer assistance. First explain that they can open Computer access in Chat, choose a connected PC and View only or Control, then select and allow a window locally on that PC. This tool keeps the current run alive while waiting; it cannot request, approve, extend or recreate access. It returns no device/window identifiers. Ready is informational; observation/input tools check authority again. If stopped, do not repeatedly prompt or try to renew it. If offline, the operator must connect the companion first. Use waitSeconds=0 for an immediate status check.",
        inputSchema: {
            type: "object",
            properties: { waitSeconds: { type: "integer", minimum: 0, maximum: 60 } },
            additionalProperties: false,
        },
        action: async (input, signal, context) => {
            const { waitSeconds } = v.parse(schema, input);
            const deadline = performance.now() + waitSeconds * 1000;
            try {
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
                        "Waiting was cancelled. This tool did not request or approve computer access."
                    );
                throw error;
            }
        },
    };
}
