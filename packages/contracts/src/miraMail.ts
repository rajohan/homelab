import * as v from "valibot";

import { idSchema, versionedIdSchema } from "./operations";

const address = v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(320),
    v.email(),
    v.regex(/^[^\r\n]+$/)
);
const recipients = v.pipe(v.array(address), v.maxLength(20));
const mailFields = {
    to: v.pipe(recipients, v.minLength(1)),
    cc: v.optional(recipients, []),
    bcc: v.optional(recipients, []),
    subject: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.maxLength(200),
        v.regex(/^[^\r\n]+$/)
    ),
    text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(48_000)),
};
export const miraMailAttachmentSchema = v.strictObject({
    id: idSchema,
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    mediaType: v.pipe(v.string(), v.maxLength(100)),
    bytes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4 * 1024 * 1024)),
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
const providerId = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(320),
    v.regex(/^[\u0021-\u007E]+$/)
);
export const miraMailReplySchema = v.strictObject({
    messageId: providerId,
    threadId: providerId,
    from: v.pipe(v.string(), v.maxLength(1000)),
    replyTo: v.optional(
        v.pipe(v.array(v.pipe(v.string(), v.maxLength(1000))), v.maxLength(100))
    ),
    subject: v.pipe(v.string(), v.maxLength(5000)),
});
export const miraMailReplyDraftSchema = v.pipe(
    v.strictObject({
        messageId: providerId,
        to: mailFields.to,
        cc: mailFields.cc,
        bcc: mailFields.bcc,
        text: mailFields.text,
        attachmentIds: v.optional(v.pipe(v.array(idSchema), v.maxLength(5))),
    }),
    v.check(
        (content) => content.to.length + content.cc.length + content.bcc.length <= 50,
        "An email can have at most 50 recipients across To, Cc and Bcc."
    )
);
export type MiraMailReply = v.InferOutput<typeof miraMailReplySchema>;
export const miraMailContentSchema = v.pipe(
    v.strictObject({
        ...mailFields,
        reply: v.optional(miraMailReplySchema),
        attachments: v.optional(
            v.pipe(v.array(miraMailAttachmentSchema), v.maxLength(5))
        ),
    }),
    v.check(
        (content) => content.to.length + content.cc.length + content.bcc.length <= 50,
        "An email can have at most 50 recipients across To, Cc and Bcc."
    )
);
export const miraMailInputSchema = v.pipe(
    v.strictObject({
        ...mailFields,
        attachmentIds: v.optional(v.pipe(v.array(idSchema), v.maxLength(5))),
    }),
    v.check(
        (content) => content.to.length + content.cc.length + content.bcc.length <= 50,
        "An email can have at most 50 recipients across To, Cc and Bcc."
    )
);
export const miraMailSaveSchema = v.strictObject({
    id: idSchema,
    version: v.pipe(v.number(), v.integer(), v.minValue(0)),
    content: miraMailInputSchema,
    conversationId: v.nullable(idSchema),
});
export const miraMailApproveSchema = v.strictObject({
    ...versionedIdSchema.entries,
    contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    reviewedReply: v.optional(v.nullable(miraMailReplySchema)),
    reviewedAttachments: v.optional(
        v.pipe(v.array(miraMailAttachmentSchema), v.maxLength(5))
    ),
});
export const miraMailFilterSchema = v.strictObject({
    before: v.optional(idSchema),
    conversationId: v.optional(idSchema),
});
export type MiraMailAttachment = v.InferOutput<typeof miraMailAttachmentSchema>;
export type MiraMailContent = v.InferOutput<typeof miraMailContentSchema>;
export type MiraMailApprove = v.InferOutput<typeof miraMailApproveSchema>;
export type MiraMailSave = v.InferOutput<typeof miraMailSaveSchema>;
export type MiraMailState =
    | "draft"
    | "queued"
    | "sending"
    | "sent"
    | "needs_attention"
    | "cancelled";
export interface MiraMailDraft {
    id: string;
    inboxId: string;
    version: number;
    state: MiraMailState;
    content: MiraMailContent;
    contentHash: string;
    conversationId: string | null;
    message: string | null;
    providerMessageId: string | null;
    providerThreadId?: string | null;
    createdAt: string;
    updatedAt: string;
}
