import * as v from "valibot";

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(512));

export const oidcConsentSchema = v.strictObject({
    interactionId: identifier,
    accountId: identifier,
    clientId: identifier,
    clientName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    username: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    redirectOrigin: v.pipe(v.string(), v.url(), v.maxLength(512)),
    scopes: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
        v.maxLength(32)
    ),
});
export const oidcConsentDecisionSchema = v.strictObject({
    interactionId: identifier,
    accountId: identifier,
    decision: v.picklist(["approve", "deny"]),
});
export const oidcInteractionSchema = v.union([
    v.strictObject({ redirect: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)) }),
    v.strictObject({ consent: oidcConsentSchema }),
]);
export type OidcConsent = v.InferOutput<typeof oidcConsentSchema>;
export type OidcConsentDecision = v.InferOutput<typeof oidcConsentDecisionSchema>;
export type OidcInteraction = v.InferOutput<typeof oidcInteractionSchema>;
