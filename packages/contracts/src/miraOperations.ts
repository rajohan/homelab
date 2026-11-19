import * as v from "valibot";

const target = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/));
export const miraHostCommandSchema = v.strictObject({
    target,
    command: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(16_384),
        v.check((value) => !value.includes("\0"))
    ),
    reason: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
    timeoutSeconds: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(86_400)),
        120
    ),
});
export const miraHostProposalSchema = v.strictObject({
    ...miraHostCommandSchema.entries,
    binding: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    permissionEpoch: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(64)))),
});
export type MiraHostCommand = v.InferOutput<typeof miraHostCommandSchema>;

export const miraHostInspectionSchema = v.variant("inspect", [
    v.strictObject({
        target,
        inspect: v.picklist([
            "identity",
            "health",
            "services",
            "disk",
            "containers",
            "github_identity",
        ]),
    }),
    v.strictObject({
        target: v.literal("main"),
        inspect: v.literal("github_pr_status"),
        number: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_147_483_647)),
    }),
]);
