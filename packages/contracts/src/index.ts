import * as v from "valibot";

export const systemStatusSchema = v.strictObject({
    name: v.literal("Homelab"),
    service: v.literal("dashboard"),
    status: v.literal("ok"),
    version: v.string(),
    phase: v.literal("identity"),
    authenticationImplemented: v.literal(true),
    integrationsImplemented: v.literal(false),
    auth: v.strictObject({
        provider: v.literal("homelab"),
        replacementEnabled: v.literal(false),
    }),
});

export type SystemStatus = v.InferOutput<typeof systemStatusSchema>;

export {
    oidcConsentSchema,
    oidcConsentDecisionSchema,
    oidcInteractionSchema,
} from "./oidcConsent";
export type { OidcConsent, OidcConsentDecision, OidcInteraction } from "./oidcConsent";
