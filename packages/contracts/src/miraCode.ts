import * as v from "valibot";

import { idSchema, versionedIdSchema } from "./operations";

export const miraCodeTitleSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(160),
    v.check((value) => value.isWellFormed() && !value.includes("\0")),
    v.regex(
        /^(feat|fix|perf|refactor|docs|test|build|ci|chore)(\([a-z0-9-]+\))?!?: [^\r\n]+$/
    )
);
export const miraCodeBodySchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(16_000),
    v.check((value) => value.isWellFormed() && !value.includes("\0"))
);
export const miraCodeInputSchema = v.strictObject({
    title: miraCodeTitleSchema,
    body: miraCodeBodySchema,
    checkId: idSchema,
    commit: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
});
export const miraCodeContentSchema = v.strictObject({
    ...miraCodeInputSchema.entries,
    edits: v.strictObject({
        id: idSchema,
        sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    }),
});
export const miraCodeSaveSchema = v.strictObject({
    id: idSchema,
    version: v.pipe(v.number(), v.integer(), v.minValue(0)),
    conversationId: v.nullable(idSchema),
    content: miraCodeInputSchema,
});
export const miraCodeApproveSchema = v.strictObject({
    ...versionedIdSchema.entries,
    contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    reviewedContent: miraCodeContentSchema,
});
export const miraCodeFilterSchema = v.strictObject({
    before: v.optional(idSchema),
    conversationId: v.optional(idSchema),
});
export type MiraCodeContent = v.InferOutput<typeof miraCodeContentSchema>;
export type MiraCodeSave = v.InferOutput<typeof miraCodeSaveSchema>;
export type MiraCodeApprove = v.InferOutput<typeof miraCodeApproveSchema>;
export interface MiraCodePublication {
    id: string;
    version: number;
    conversationId: string | null;
    state:
        | "draft"
        | "queued"
        | "publishing"
        | "published"
        | "needs_attention"
        | "cancelled";
    content: MiraCodeContent;
    contentHash: string;
    phase: string | null;
    branch: string | null;
    commit: string | null;
    number: number | null;
    observation: {
        branchSha: string | null;
        pullRequest: {
            number: number;
            url: string;
            state: "open" | "closed";
            draft: boolean;
            commit: string;
            base: string;
        } | null;
    } | null;
    inspectionRequested: boolean;
    observedAt: string | null;
    message: string | null;
    createdAt: string;
    updatedAt: string;
}
