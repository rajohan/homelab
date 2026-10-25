import * as v from "valibot";

import { idSchema, versionedIdSchema } from "./operations";

export const miraPublicationPathSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(240),
    v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/)
);
export const miraPublicationTargetSchema = v.strictObject({
    slug: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(128),
        v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    ),
    baseVersionId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
});
const selection = v.strictObject({ id: idSchema, path: miraPublicationPathSchema });
const fields = {
    title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
    target: v.nullable(miraPublicationTargetSchema),
    visibility: v.literal("anyone_with_link"),
};
export const miraPublicationInputSchema = v.strictObject({
    ...fields,
    files: v.pipe(v.array(selection), v.minLength(1), v.maxLength(8)),
});
export const miraPublicationFileSchema = v.strictObject({
    ...selection.entries,
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    mediaType: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    bytes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(25 * 1024 * 1024)),
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
export const miraPublicationContentSchema = v.strictObject({
    ...fields,
    files: v.pipe(v.array(miraPublicationFileSchema), v.minLength(1), v.maxLength(8)),
});
export const miraPublicationSaveSchema = v.strictObject({
    id: idSchema,
    version: v.pipe(v.number(), v.integer(), v.minValue(0)),
    content: miraPublicationInputSchema,
    conversationId: v.nullable(idSchema),
});
export const miraPublicationApproveSchema = v.strictObject({
    ...versionedIdSchema.entries,
    contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    reviewedContent: miraPublicationContentSchema,
});
export const miraPublicationFilterSchema = v.strictObject({
    before: v.optional(idSchema),
    conversationId: v.optional(idSchema),
});
export type MiraPublicationFile = v.InferOutput<typeof miraPublicationFileSchema>;
export type MiraPublicationContent = v.InferOutput<typeof miraPublicationContentSchema>;
export type MiraPublicationInput = v.InferOutput<typeof miraPublicationInputSchema>;
export type MiraPublicationSave = v.InferOutput<typeof miraPublicationSaveSchema>;
export type MiraPublicationApprove = v.InferOutput<typeof miraPublicationApproveSchema>;
export type MiraPublicationState =
    | "draft"
    | "queued"
    | "publishing"
    | "published"
    | "needs_attention"
    | "cancelled";
export interface MiraPublication {
    id: string;
    accountId: string;
    version: number;
    state: MiraPublicationState;
    content: MiraPublicationContent;
    contentHash: string;
    conversationId: string | null;
    phase: string | null;
    slug: string | null;
    providerVersionId: string | null;
    message: string | null;
    createdAt: string;
    updatedAt: string;
}
