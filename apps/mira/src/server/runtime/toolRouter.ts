import * as v from "valibot";

import type { RuntimeTool } from "./protocol";

/**
 * Keep provider declarations stable while resolving the current server-side tool registry on every run.
 * @param tools - Scoped, audited handlers registered for this product run.
 * @param includeLegacyHandlers - Accept persisted direct declarations when resuming pre-router threads.
 * @returns Discovery and invocation tools whose schemas remain valid through provider thread resume.
 */
export function createMiraToolRouter(
    tools: RuntimeTool[],
    includeLegacyHandlers = false
): RuntimeTool[] {
    const registry = new Map(tools.map((tool) => [tool.name, tool]));
    if (
        registry.size !== tools.length ||
        tools.length > 100 ||
        registry.has("mira_tools_list") ||
        registry.has("mira_tool_call")
    )
        throw new Error("Mira tool registry is invalid.");
    return [
        {
            name: "mira_tools_list",
            description:
                "Discover the current Mira tools, their argument schemas and capabilities. Check this registry before using tools in each turn; integrations and permissions can change between turns.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: (input, signal) => {
                signal.throwIfAborted();
                v.parse(v.strictObject({}), input);
                return Promise.resolve(
                    JSON.stringify(
                        tools.map(({ name, description, inputSchema }) => ({
                            name,
                            description,
                            inputSchema,
                        }))
                    )
                );
            },
        },
        {
            name: "mira_tool_call",
            description:
                "Invoke a tool returned by mira_tools_list using its exact argument schema. The server enforces current permissions and records the actual tool outcome. Discovery never grants extra authority.",
            inputSchema: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    arguments: { type: "object", additionalProperties: true },
                },
                required: ["name", "arguments"],
                additionalProperties: false,
            },
            execute: (input, signal, call) => {
                signal.throwIfAborted();
                const parsed = v.parse(
                    v.strictObject({
                        name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
                        arguments: v.record(v.string(), v.unknown()),
                    }),
                    input
                );
                const tool = registry.get(parsed.name);
                if (!tool)
                    throw new Error("This tool is not available in the current run.");
                return tool.execute(parsed.arguments, signal, call);
            },
        },
        ...(includeLegacyHandlers ? tools : []),
    ];
}
