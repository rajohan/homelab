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
export const miraMailContentSchema = v.strictObject({
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
});
export const miraMailSaveSchema = v.strictObject({
    id: idSchema,
    version: v.pipe(v.number(), v.integer(), v.minValue(0)),
    content: miraMailContentSchema,
    conversationId: v.nullable(idSchema),
});
export const miraMailApproveSchema = v.strictObject({
    ...versionedIdSchema.entries,
    contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
export const miraMailFilterSchema = v.strictObject({
    before: v.optional(idSchema),
    conversationId: v.optional(idSchema),
});
export type MiraMailContent = v.InferOutput<typeof miraMailContentSchema>;
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
    createdAt: string;
    updatedAt: string;
}
