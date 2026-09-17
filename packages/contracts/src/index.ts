import * as v from "valibot";

export const systemStatusSchema = v.strictObject({
    name: v.literal("Homelab"),
    service: v.literal("dashboard"),
    status: v.literal("ok"),
    version: v.string(),
    phase: v.literal("operations"),
    authenticationImplemented: v.literal(true),
    integrationsImplemented: v.literal(true),
    auth: v.strictObject({
        provider: v.literal("homelab"),
    }),
});

export type SystemStatus = v.InferOutput<typeof systemStatusSchema>;

export {
    oidcScopeDescriptions,
    oidcConsentSchema,
    oidcConsentDecisionSchema,
    oidcInteractionSchema,
} from "./oidcConsent";
export type { OidcConsent, OidcConsentDecision, OidcInteraction } from "./oidcConsent";

export { passwordPolicy } from "./passwordPolicy";
