import * as v from "valibot";

const id = v.union([v.string(), v.pipe(v.number(), v.integer())]);
export const envelopeSchema = v.union([
    v.object({ id, method: v.string(), params: v.optional(v.unknown()) }),
    v.object({ method: v.string(), params: v.optional(v.unknown()) }),
    v.object({ id, error: v.object({ code: v.number(), message: v.string() }) }),
    v.object({ id, result: v.unknown() }),
]);
export type RpcId = v.InferOutput<typeof id>;
export interface RuntimeEvent {
    method: string;
    params: unknown;
}
export const accountSchema = v.object({
    account: v.nullable(v.object({ type: v.string(), planType: v.optional(v.string()) })),
});
export const modelsSchema = v.object({
    data: v.array(v.object({ model: v.string(), isDefault: v.boolean() })),
    nextCursor: v.nullable(v.string()),
});
export const initializeSchema = v.object({ codexHome: v.string() });
export const threadSchema = v.object({
    thread: v.object({ id: v.string() }),
    modelProvider: v.literal("openai"),
    cwd: v.string(),
    instructionSources: v.pipe(v.array(v.string()), v.maxLength(0)),
    approvalPolicy: v.literal("untrusted"),
    sandbox: v.object({
        type: v.literal("readOnly"),
        networkAccess: v.optional(v.literal(false), false),
    }),
});
export const turnSchema = v.object({ turn: v.object({ id: v.string() }) });
export const completedSchema = v.object({
    threadId: v.string(),
    turn: v.object({
        id: v.string(),
        status: v.picklist(["completed", "interrupted", "failed", "inProgress"]),
    }),
});
export const deltaSchema = v.object({
    threadId: v.string(),
    turnId: v.string(),
    delta: v.string(),
});
export const toolCallSchema = v.object({
    threadId: v.string(),
    turnId: v.string(),
    callId: v.string(),
    tool: v.string(),
    arguments: v.unknown(),
});
export interface RuntimeTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (input: unknown, signal: AbortSignal) => Promise<string>;
}
export interface TurnResult {
    id: string;
    status: "completed" | "interrupted" | "failed";
    text: string;
}
