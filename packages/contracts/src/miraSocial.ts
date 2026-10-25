import * as v from "valibot";

import { idSchema, versionedIdSchema } from "./operations";

const identifier = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(128),
    v.regex(/^[A-Za-z0-9_-]+$/)
);
const text = (maximum: number) =>
    v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(maximum),
        v.check(
            (value) => value.isWellFormed() && value.trim().length > 0,
            "Use nonempty valid Unicode text."
        )
    );
export const miraSocialContentSchema = v.variant("kind", [
    v.strictObject({
        kind: v.literal("post"),
        community: v.pipe(v.string(), v.regex(/^[a-z0-9_]{2,30}$/)),
        title: text(300),
        text: text(40_000),
    }),
    v.strictObject({
        kind: v.literal("comment"),
        postId: identifier,
        parentId: v.nullable(identifier),
        text: text(10_000),
    }),
]);
export const miraSocialSaveSchema = v.strictObject({
    id: idSchema,
    version: v.pipe(v.number(), v.integer(), v.minValue(0)),
    conversationId: v.nullable(idSchema),
    content: miraSocialContentSchema,
});
export const miraSocialApproveSchema = v.strictObject({
    ...versionedIdSchema.entries,
    contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    reviewedContent: miraSocialContentSchema,
});
export const miraSocialVerifySchema = v.strictObject({
    ...versionedIdSchema.entries,
    answer: v.pipe(v.string(), v.regex(/^-?\d{1,12}\.\d{2}$/)),
});
export const miraSocialFilterSchema = v.strictObject({
    before: v.optional(idSchema),
    conversationId: v.optional(idSchema),
});
export type MiraSocialContent = v.InferOutput<typeof miraSocialContentSchema>;
export type MiraSocialSave = v.InferOutput<typeof miraSocialSaveSchema>;
export type MiraSocialApprove = v.InferOutput<typeof miraSocialApproveSchema>;
export type MiraSocialVerify = v.InferOutput<typeof miraSocialVerifySchema>;
export interface MiraSocialDraft {
    id: string;
    agentName: string;
    version: number;
    state:
        | "draft"
        | "queued"
        | "publishing"
        | "verification_required"
        | "queued_verification"
        | "verifying"
        | "submitted"
        | "needs_attention"
        | "cancelled";
    content: MiraSocialContent;
    contentHash: string;
    conversationId: string | null;
    providerId: string | null;
    challenge: string | null;
    expiresAt: string | null;
    message: string | null;
    createdAt: string;
    updatedAt: string;
}
