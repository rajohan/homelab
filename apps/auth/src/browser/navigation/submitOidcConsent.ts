import {
    oidcInteractionSchema,
    type OidcConsent,
    type OidcConsentDecision,
} from "@homelab/contracts";
import type { IdentityClient } from "@homelab/ui/identity/client";
import * as v from "valibot";

/**
 * Submit the displayed interaction's decision and validate the provider's local resume address.
 * @param client - The signed-in browser's authenticated transport.
 * @param address - The auth page's origin.
 * @param consent - The exact interaction/account shown in the modal.
 * @param decision - The user's explicit approve or deny action.
 * @returns The same-origin provider resume URL; external client redirects remain provider-owned.
 * @throws {Error} The response is not a valid local continuation.
 */
export async function submitOidcConsent(
    client: IdentityClient,
    address: URL,
    consent: OidcConsent,
    decision: OidcConsentDecision["decision"]
): Promise<string> {
    const result = v.parse(
        oidcInteractionSchema,
        await client.request("/sign-in/complete", {
            interactionId: consent.interactionId,
            accountId: consent.accountId,
            decision,
        })
    );
    if (!("redirect" in result)) throw new Error("Consent was not completed.");
    const target = new URL(result.redirect, address.origin);
    if (target.origin !== address.origin)
        throw new Error("Invalid authorization return address.");
    return target.href;
}
