import * as v from "valibot";

import { idSchema, versionedIdSchema } from "./operations";

const name = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(160),
    v.regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/)
);
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const miraDaytonaContentSchema = v.strictObject({
    title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
    command: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(16_384),
        v.check(
            (value) =>
                value.isWellFormed() &&
                value.trim().length > 0 &&
                !value.includes("\0") &&
                new TextEncoder().encode(value).length <= 16_384
        )
    ),
    inputs: v.pipe(
        v.array(v.strictObject({ id: idSchema, name, sha256: hash })),
        v.maxLength(4),
        v.check(
            (values) =>
                new Set(values.map((value) => value.name)).size === values.length &&
                new Set(values.map((value) => value.id)).size === values.length
        )
    ),
    outputs: v.pipe(
        v.array(name),
        v.maxLength(4),
        v.check((values) => new Set(values).size === values.length)
    ),
});
export const miraDaytonaSaveSchema = v.strictObject({
    id: idSchema,
    version: v.pipe(v.number(), v.integer(), v.minValue(0)),
    conversationId: v.nullable(idSchema),
    taskId: v.nullable(idSchema),
    content: miraDaytonaContentSchema,
});
export const miraDaytonaApproveSchema = v.strictObject({
    ...versionedIdSchema.entries,
    contentHash: hash,
    reviewedContent: miraDaytonaContentSchema,
});
export const miraDaytonaFilterSchema = v.strictObject({
    before: v.optional(idSchema),
    conversationId: v.optional(idSchema),
});
export type MiraDaytonaContent = v.InferOutput<typeof miraDaytonaContentSchema>;
export type MiraDaytonaSave = v.InferOutput<typeof miraDaytonaSaveSchema>;
export type MiraDaytonaApprove = v.InferOutput<typeof miraDaytonaApproveSchema>;
export interface MiraDaytonaJob {
    id: string;
    version: number;
    content: MiraDaytonaContent;
    contentHash: string;
    conversationId: string | null;
    taskId: string | null;
    state:
        | "draft"
        | "queued"
        | "running"
        | "completed"
        | "failed"
        | "cancelled"
        | "needs_attention";
    phase: string;
    cleanup: "not_needed" | "pending" | "confirmed" | "operator_confirmed";
    cancelRequested: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    output: string;
    files: { name: string; id: string }[];
    message: string | null;
    createdAt: string;
    updatedAt: string;
}

export const miraDaytonaResolveSchema = v.strictObject({
    id: idSchema,
    identityHash: hash,
    sandboxName: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    reason: v.pipe(v.string(), v.trim(), v.minLength(10), v.maxLength(2000)),
    accountInspected: v.literal(true),
});
export type MiraDaytonaResolve = v.InferOutput<typeof miraDaytonaResolveSchema>;
export interface MiraDaytonaResolution {
    actor: string;
    reason: string;
    at: string;
}
export interface MiraDaytonaRecovery {
    id: string;
    identityHash: string;
    organizationId: string;
    snapshotId: string;
    target: string;
    sandboxId: string | null;
    sandboxName: string;
    eligibleAt: string | null;
    blockedReason: string | null;
    resolution: MiraDaytonaResolution | null;
}
