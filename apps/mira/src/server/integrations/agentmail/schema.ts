import * as v from "valibot";

export const agentMailIdSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(320),
    v.regex(/^[\u0021-\u007E]+$/)
);
export const agentMailMessageSchema = v.object({
    inbox_id: agentMailIdSchema,
    message_id: agentMailIdSchema,
    thread_id: agentMailIdSchema,
    timestamp: v.pipe(v.string(), v.isoTimestamp()),
    labels: v.pipe(v.array(v.pipe(v.string(), v.maxLength(100))), v.maxLength(100)),
    from: v.pipe(v.string(), v.maxLength(1000)),
    subject: v.optional(v.pipe(v.string(), v.maxLength(5000)), ""),
    preview: v.optional(v.pipe(v.string(), v.maxLength(5000)), ""),
});
export type AgentMailMessage = v.InferOutput<typeof agentMailMessageSchema>;
export const agentMailMessagePageSchema = v.object({
    messages: v.pipe(v.array(agentMailMessageSchema), v.maxLength(100)),
    next_page_token: v.nullish(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});
export const agentMailContentSchema = v.object({
    ...agentMailMessageSchema.entries,
    text: v.optional(v.pipe(v.string(), v.maxLength(1_000_000))),
    html: v.optional(v.pipe(v.string(), v.maxLength(1_000_000))),
    extracted_text: v.optional(v.pipe(v.string(), v.maxLength(1_000_000))),
    extracted_html: v.optional(v.pipe(v.string(), v.maxLength(1_000_000))),
});

/**
 * Keep rejected, unauthenticated and deleted mail out of automatic review.
 * @param message - Validated provider metadata.
 * @returns Whether this is an ordinary received message eligible for review.
 */
export function ordinaryReceivedMail(message: Pick<AgentMailMessage, "labels">): boolean {
    return (
        message.labels.includes("received") &&
        !message.labels.some((label) =>
            ["spam", "blocked", "unauthenticated", "trash"].includes(label)
        )
    );
}
