import * as v from "valibot";

import { idSchema, versionedIdSchema } from "./operations";
import { scheduleConfigurationSchema } from "./schedules";

const text = (maximum: number) => v.pipe(v.string(), v.trim(), v.maxLength(maximum));
const title = v.pipe(text(160), v.minLength(1));
const body = text(32_000);
export const miraPageSchema = v.strictObject({
    before: v.optional(idSchema),
    search: v.optional(text(160), ""),
    archived: v.optional(v.boolean(), false),
});
export const miraTaskStates = ["todo", "in_progress", "blocked", "done"] as const;
export const miraTaskInputSchema = v.strictObject({
    title,
    description: body,
    status: v.picklist(miraTaskStates),
    assignee: v.picklist(["mira", "operator"]),
    priority: v.picklist(["low", "normal", "high", "urgent"]),
    labels: v.pipe(v.array(v.pipe(text(40), v.minLength(1))), v.maxLength(12)),
    dueAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
    completionCriteria: text(4000),
    conversationId: v.nullable(idSchema),
});
export const miraTaskUpdateSchema = v.strictObject({
    ...versionedIdSchema.entries,
    ...miraTaskInputSchema.entries,
});
export const miraTaskFilterSchema = v.strictObject({
    ...miraPageSchema.entries,
    status: v.optional(v.picklist(miraTaskStates)),
    assignee: v.optional(v.picklist(["mira", "operator"])),
});
export const miraConversationInputSchema = v.strictObject({ title });
export const miraStateChangeSchema = v.strictObject({
    ...versionedIdSchema.entries,
    action: v.picklist(["archive", "restore", "delete"]),
});
export const miraMessageInputSchema = v.strictObject({
    conversationId: idSchema,
    requestId: idSchema,
    text: v.pipe(body, v.minLength(1)),
    attachmentIds: v.optional(v.pipe(v.array(idSchema), v.maxLength(8)), []),
});
export const miraConversationReadSchema = v.strictObject({
    id: idSchema,
    before: v.optional(idSchema),
});
export const miraProgressInputSchema = v.strictObject({
    taskId: idSchema,
    text: v.pipe(text(4000), v.minLength(1)),
});
export const miraReportInputSchema = v.strictObject({
    title,
    kind: v.picklist(["brief", "summary", "improvement", "task", "other"]),
    markdown: v.pipe(body, v.minLength(1)),
    taskId: v.optional(v.nullable(idSchema), null),
});
export const miraReportFilterSchema = v.strictObject({
    ...miraPageSchema.entries,
    kind: v.optional(miraReportInputSchema.entries.kind),
    source: v.optional(v.picklist(["manual", "chat", "automation"])),
    outcome: v.optional(
        v.picklist([
            "queued",
            "running",
            "completed",
            "interrupted",
            "failed",
            "needs_attention",
        ])
    ),
    from: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    until: v.optional(v.pipe(v.string(), v.isoTimestamp())),
});
export const miraMemoryInputSchema = v.strictObject({ title, content: body });
export const miraMemoryUpdateSchema = v.strictObject({
    ...versionedIdSchema.entries,
    ...miraMemoryInputSchema.entries,
});
export const miraScheduleSchema = v.union([
    scheduleConfigurationSchema,
    v.strictObject({ kind: v.literal("once"), at: v.pipe(v.string(), v.isoTimestamp()) }),
    v.strictObject({
        kind: v.literal("event"),
        event: v.picklist(["agentmail", "task_due"]),
    }),
]);
export const miraAutomationInputSchema = v.strictObject({
    delivery: v.optional(v.picklist(["reports", "changes", "silent"]), "changes"),
    title,
    prompt: v.pipe(body, v.minLength(1)),
    schedule: miraScheduleSchema,
    budgetSeconds: v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(900)),
    kind: v.picklist(["brief", "summary", "improvement", "custom"]),
});
export const miraAutomationUpdateSchema = v.strictObject({
    ...versionedIdSchema.entries,
    ...miraAutomationInputSchema.entries,
});
export const miraEnableSchema = v.pipe(
    v.strictObject({
        key: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_:.-]{0,119}$/)),
        version: v.pipe(v.number(), v.integer(), v.minValue(1)),
        enabled: v.boolean(),
        reason: v.nullable(v.pipe(text(1000), v.minLength(1))),
        until: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
    }),
    v.check(
        (value) =>
            value.enabled
                ? value.reason === null && value.until === null
                : value.reason !== null,
        "Provide a reason when disabling; clear it when enabling."
    )
);
export type MiraTaskInput = v.InferOutput<typeof miraTaskInputSchema>;
export interface MiraTask extends MiraTaskInput {
    id: string;
    version: number;
    createdAt: string;
    updatedAt: string;
}
export interface MiraConversation {
    id: string;
    title: string;
    version: number;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface MiraMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    state: "queued" | "streaming" | "completed" | "interrupted" | "failed";
    attachmentIds: string[];
    createdAt: string;
}
export type MiraRunState =
    | "queued"
    | "running"
    | "completed"
    | "interrupted"
    | "failed"
    | "needs_attention";
export interface MiraRun {
    id: string;
    conversationId: string;
    automationId: string | null;
    taskId: string | null;
    state: MiraRunState;
    cancelRequested: boolean;
    message: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}
export interface MiraReport extends v.InferOutput<typeof miraReportInputSchema> {
    id: string;
    runId: string | null;
    version: number;
    archivedAt: string | null;
    createdAt: string;
    source: "manual" | "chat" | "automation";
    outcome: MiraRunState | null;
    automationId: string | null;
    conversationId: string | null;
}
export interface MiraMemory extends v.InferOutput<typeof miraMemoryInputSchema> {
    id: string;
    version: number;
    updatedAt: string;
}
export interface MiraAutomation extends v.InferOutput<typeof miraAutomationInputSchema> {
    id: string;
    version: number;
    nextRunAt: string | null;
}
export interface MiraSwitch {
    key: string;
    enabled: boolean;
    reason: string | null;
    until: string | null;
    version: number;
}
export interface MiraAttachment {
    id: string;
    name: string;
    mediaType: string;
    bytes: number;
    createdAt: string;
}
export type MiraSchedule = v.InferOutput<typeof miraScheduleSchema>;
