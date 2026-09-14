import * as v from "valibot";

export const systemStatusSchema = v.strictObject({
    name: v.literal("Homelab"),
    service: v.literal("dashboard"),
    status: v.literal("ok"),
    version: v.string(),
    phase: v.literal("foundation"),
    authenticationImplemented: v.literal(false),
    integrationsImplemented: v.literal(false),
    auth: v.strictObject({
        provider: v.literal("authelia"),
        replacementEnabled: v.literal(false),
    }),
});

export type SystemStatus = v.InferOutput<typeof systemStatusSchema>;
