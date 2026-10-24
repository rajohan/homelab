import * as v from "valibot";

export const agentMailIdSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(320),
    v.regex(/^[\u0021-\u007E]+$/)
);
const agentArmorSchema = v.object({
    status: v.picklist(["pending", "complete", "unavailable"]),
    verdict: v.optional(v.picklist(["clear", "review"])),
    manual_override: v.nullish(
        v.object({ released_at: v.pipe(v.string(), v.isoTimestamp()) })
    ),
});
export const agentMailMessageSchema = v.object({
    inbox_id: agentMailIdSchema,
    message_id: agentMailIdSchema,
    thread_id: agentMailIdSchema,
    timestamp: v.pipe(v.string(), v.isoTimestamp()),
    created_at: v.pipe(v.string(), v.isoTimestamp()),
    labels: v.pipe(v.array(v.pipe(v.string(), v.maxLength(100))), v.maxLength(100)),
    agent_armor: v.optional(agentArmorSchema),
    from: v.pipe(v.string(), v.maxLength(1000)),
    subject: v.optional(v.pipe(v.string(), v.maxLength(5000)), ""),
    preview: v.optional(v.pipe(v.string(), v.maxLength(5000)), ""),
});
export type AgentMailMessage = v.InferOutput<typeof agentMailMessageSchema>;
export const agentMailMessagePageSchema = v.object({
    messages: v.pipe(v.array(agentMailMessageSchema), v.maxLength(100)),
    next_page_token: v.nullish(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});
export const agentMailEventPageSchema = v.object({
    events: v.pipe(
        v.array(
            v.object({
                event_id: agentMailIdSchema,
                inbox_id: agentMailIdSchema,
                message_id: agentMailIdSchema,
                created_at: v.pipe(v.string(), v.isoTimestamp()),
            })
        ),
        v.maxLength(25)
    ),
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
export function ordinaryReceivedMail(
    message: Pick<AgentMailMessage, "labels" | "agent_armor">
): boolean {
    return (
        message.labels.includes("received") &&
        (!message.agent_armor ||
            (message.agent_armor.status === "complete" &&
                (message.agent_armor.verdict === "clear" ||
                    Boolean(message.agent_armor.manual_override)))) &&
        !message.labels.some((label) =>
            ["spam", "blocked", "unauthenticated", "trash", "agent-armor-held"].includes(
                label
            )
        )
    );
}
