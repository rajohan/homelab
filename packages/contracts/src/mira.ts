import * as v from "valibot";

import { idSchema, versionedIdSchema } from "./operations";
import { scheduleConfigurationSchema } from "./schedules";
import { tableCursorSchema, tableSortSchema } from "./tableSort";

const text = (maximum: number) => v.pipe(v.string(), v.trim(), v.maxLength(maximum));
const title = v.pipe(text(160), v.minLength(1));
const body = text(32_000);
export const miraCodeTargetSchema = v.picklist(["main", "daytona"]);
export const miraPageSchema = v.strictObject({
    before: v.optional(idSchema),
    search: v.optional(text(160), ""),
    archived: v.optional(v.boolean(), false),
});
export const miraConversationCursorSchema = v.strictObject({
    id: idSchema,
    updatedAt: v.pipe(v.string(), v.isoTimestamp()),
});
export type MiraConversationCursor = v.InferOutput<typeof miraConversationCursorSchema>;
export const miraConversationPageSchema = v.strictObject({
    ...miraPageSchema.entries,
    before: v.optional(miraConversationCursorSchema),
});
export const miraActionKindSchema = v.picklist([
    "code",
    "job",
    "mail",
    "publication",
    "social",
]);
export const miraActionCursorSchema = v.strictObject({
    id: idSchema,
    kind: miraActionKindSchema,
    pending: v.boolean(),
    createdAt: v.pipe(v.string(), v.isoTimestamp()),
});
export type MiraActionCursor = v.InferOutput<typeof miraActionCursorSchema>;
export const miraActionPageSchema = v.strictObject({
    id: v.exactOptional(idSchema),
    before: v.exactOptional(miraActionCursorSchema),
});
export const miraHistorySearchSchema = v.strictObject({
    query: v.pipe(text(160), v.minLength(2)),
});
export const miraConversationHistorySchema = v.strictObject({
    beforeMessageId: v.optional(idSchema),
    query: v.optional(v.pipe(text(160), v.minLength(2))),
});
export const miraHistoryReadSchema = v.strictObject({
    messageId: idSchema,
    offset: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(256_000)),
        0
    ),
});
export const miraTaskStates = ["todo", "in_progress", "blocked", "done"] as const;
export const miraTaskInputSchema = v.strictObject({
    title,
    autoStart: v.optional(v.boolean()),
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
export const miraTaskReviewInputSchema = v.strictObject({
    ...versionedIdSchema.entries,
    runId: idSchema,
});
export const miraTaskRunInputSchema = v.strictObject({
    ...versionedIdSchema.entries,
    requestId: idSchema,
    instructions: v.optional(text(4000), ""),
    reviewedRunId: v.optional(v.nullable(idSchema), null),
    executionTarget: v.optional(miraCodeTargetSchema),
});
export const miraTaskFilterSchema = v.strictObject({
    ...miraPageSchema.entries,
    due: v.optional(v.boolean()),
    status: v.optional(v.picklist(miraTaskStates)),
    assignee: v.optional(v.picklist(["mira", "operator"])),
});
const miraTaskBoardCursorSchema = v.strictObject({
    id: idSchema,
    rank: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(3)),
    at: v.pipe(v.string(), v.isoTimestamp()),
});
export const miraTaskBoardFilterSchema = v.strictObject({
    ...miraTaskFilterSchema.entries,
    before: v.optional(v.union([idSchema, miraTaskBoardCursorSchema])),
});
export type MiraTaskBoardCursor = v.InferOutput<typeof miraTaskBoardCursorSchema>;
export const miraConversationInputSchema = v.strictObject({ title });
export const miraStateChangeSchema = v.strictObject({
    ...versionedIdSchema.entries,
    action: v.picklist(["archive", "restore", "delete"]),
});
export const miraMessageInputSchema = v.strictObject({
    conversationId: idSchema,
    requestId: idSchema,
    text: v.pipe(body, v.minLength(1)),
    attachmentIds: v.optional(
        v.pipe(
            v.array(idSchema),
            v.maxLength(8),
            v.check(
                (ids) => new Set(ids).size === ids.length,
                "Attach each file only once."
            )
        ),
        []
    ),
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
        event: v.picklist(["agentmail", "task_due", "task_changed"]),
    }),
]);
const modelIdentifier = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(160),
    v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
);
export const miraChatSettingsSchema = v.strictObject({
    model: v.nullable(modelIdentifier),
    effort: v.nullable(modelIdentifier),
    serviceTier: v.nullable(modelIdentifier),
    useMemory: v.optional(v.boolean()),
    useHistory: v.optional(v.boolean()),
    executionTarget: v.optional(miraCodeTargetSchema),
});
export const miraDefaultChatSettings = { model: null, effort: null, serviceTier: null };
export type MiraChatSettings = v.InferOutput<typeof miraChatSettingsSchema>;

export const miraAutomationInputSchema = v.strictObject({
    settings: v.optional(miraChatSettingsSchema),
    delivery: v.optional(v.picklist(["reports", "changes", "silent"]), "changes"),
    title,
    prompt: v.pipe(body, v.minLength(1)),
    schedule: miraScheduleSchema,
    budgetSeconds: v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(3600)),
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
    number: number;
    completedAt: string | null;
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
export interface MiraMessagePart {
    id: string;
    /** Speaker for a question/answer segment; ordinary replies inherit their message role. */
    role?: "user" | "assistant";
    /** Unicode code-point offset, matching PostgreSQL substring and history chunks. */
    offset: number;
    createdAt: string;
    /** True confirms completion; explicit false preserves an unconfirmed stream across later replies. */
    completed?: boolean;
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
export interface MiraActivity {
    phase:
        | "starting"
        | "connecting"
        | "preparing"
        | "compacting"
        | "thinking"
        | "replying"
        | "tool"
        | "working";
    tool: string | null;
    /** Provider-supplied display summary; never raw hidden reasoning. */
    thinking?: string;
    /** Stable provider turn and Unicode offset of its bounded visible tail. */
    thinkingId?: string;
    thinkingOffset?: number;
}
export interface MiraRun {
    followupResolution?: MiraRunResolution | null;
    manual?: boolean;
    activity?: MiraActivity | null;
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
export interface MiraRunSummary extends MiraRun {
    title: string;
    automationName: string | null;
    conversationAvailable: boolean;
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

export const miraChatSettingsUpdateSchema = v.strictObject({
    ...versionedIdSchema.entries,
    settings: miraChatSettingsSchema,
});
const modelLabel = v.pipe(v.string(), v.maxLength(160));
const modelDescription = v.pipe(v.string(), v.maxLength(4000));
export const miraModelSchema = v.object({
    model: modelIdentifier,
    isDefault: v.boolean(),
    displayName: v.optional(modelLabel, ""),
    description: v.optional(modelDescription, ""),
    defaultReasoningEffort: v.optional(v.nullable(modelIdentifier), null),
    supportedReasoningEfforts: v.optional(
        v.pipe(
            v.array(
                v.object({
                    reasoningEffort: modelIdentifier,
                    description: modelDescription,
                })
            ),
            v.maxLength(32)
        ),
        []
    ),
    defaultServiceTier: v.optional(v.nullable(modelIdentifier), null),
    serviceTiers: v.optional(
        v.pipe(
            v.array(
                v.object({
                    id: modelIdentifier,
                    name: modelLabel,
                    description: modelDescription,
                })
            ),
            v.maxLength(16)
        ),
        []
    ),
    inputModalities: v.optional(v.array(v.picklist(["text", "image"])), [
        "text",
        "image",
    ]),
});
export type MiraModel = v.InferOutput<typeof miraModelSchema>;

const questionOptionSchema = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(240)
);
const questionSchema = v.strictObject({
    id: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/)),
    title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1000)),
    options: v.optional(v.pipe(v.array(questionOptionSchema), v.maxLength(6)), []),
});
export const miraQuestionRequestSchema = v.strictObject({
    questions: v.pipe(
        v.array(questionSchema),
        v.minLength(1),
        v.maxLength(3),
        v.check(
            (questions) =>
                new Set(questions.map((question) => question.id)).size ===
                questions.length
        )
    ),
});
export const miraQuestionAnswerSchema = v.strictObject({
    id: idSchema,
    inputHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    answers: v.record(
        v.pipe(v.string(), v.maxLength(64)),
        v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000))
    ),
});
export type MiraQuestionRequest = v.InferOutput<typeof miraQuestionRequestSchema>;

export const miraProposalDecisionSchema = v.strictObject({
    id: idSchema,
    inputHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    approve: v.boolean(),
});
export interface MiraProposal {
    readonly id: string;
    readonly tool: string;
    readonly inputHash: string;
    readonly input: Record<string, unknown>;
    readonly createdAt: string;
    readonly message?: string | null;
}

export const miraRunReadSchema = v.strictObject({
    id: idSchema,
    before: v.optional(idSchema),
});
export const miraRunResolveSchema = v.strictObject({
    id: idSchema,
    outcome: v.picklist(["reviewed", "dismissed"]),
    reason: v.pipe(v.string(), v.trim(), v.minLength(4), v.maxLength(2000)),
});
export interface MiraRunResolution {
    outcome: "reviewed" | "dismissed";
    reason: string;
    closedAt: string;
    closedBy: string;
}
export interface MiraToolReceipt {
    id: string;
    tool: string;
    state: string;
    message: string | null;
    createdAt: string;
    finishedAt: string | null;
}

export const miraQuotaSchema = v.object({
    provider: v.literal("chatgpt"),
    observedAt: v.string(),
    windows: v.array(
        v.object({
            label: v.string(),
            remainingPercent: v.pipe(
                v.number(),
                v.finite(),
                v.minValue(0),
                v.maxValue(100)
            ),
            resetsAt: v.nullable(v.string()),
        })
    ),
});
export type MiraQuota = v.InferOutput<typeof miraQuotaSchema>;

/** Paging and filtering for the complete owned run history. */
export const miraRunListSchema = v.strictObject({
    ...miraPageSchema.entries,
    needsReview: v.optional(v.boolean(), false),
    sort: v.optional(tableSortSchema(["conversation", "state", "time"])),
    sortCursor: v.optional(tableCursorSchema),
});
