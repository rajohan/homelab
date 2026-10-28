import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import type { RuntimeTool } from "../../../../mira/src/server/runtime/protocol";

/**
 * Preserve the strict text assertions in existing nonvisual tool integration suites.
 * @param args - The real executor tool factory inputs; no action or receipt is mocked.
 * @returns Real tools with an explicit assertion that each tested result is JSON text.
 */
export function createMiraTextTestTools(
    ...args: Parameters<typeof createMiraTools>
): RuntimeTool[] {
    return createMiraTools(...args).map((tool) => ({
        ...tool,
        execute: async (input, signal, call) => {
            const result = await tool.execute(input, signal, call);
            if (typeof result !== "string")
                throw new Error("This test expects a text tool result.");
            return result;
        },
    }));
}
