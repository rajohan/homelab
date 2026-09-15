import * as v from "valibot";

const date = v.string();
export const accountSchema = v.object({
    user: v.object({
        id: v.string(),
        username: v.string(),
        email: v.string(),
        emailVerified: v.boolean(),
    }),
    factors: v.array(
        v.object({
            id: v.string(),
            kind: v.picklist(["totp", "webauthn"]),
            label: v.string(),
            createdAt: date,
            lastUsedAt: v.nullable(date),
        })
    ),
    recoveryCodesRemaining: v.number(),
    sessions: v.array(
        v.object({
            id: v.string(),
            userAgent: v.string(),
            createdAt: date,
            lastSeenAt: date,
            expiresAt: date,
            current: v.boolean(),
        })
    ),
    events: v.array(v.object({ id: v.string(), event: v.string(), createdAt: date })),
});
export type AccountSnapshot = v.InferOutput<typeof accountSchema>;
export const sessionSchema = v.object({
    authenticated: v.boolean(),
    mfaRequired: v.boolean(),
    methods: v.array(v.picklist(["totp", "webauthn"])),
    username: v.optional(v.string()),
    userId: v.optional(v.string()),
    recoveryAvailable: v.optional(v.boolean()),
});
