import { oidcInteractionSchema, type OidcConsent } from "@homelab/contracts";
import { IdentityError, type IdentityClient } from "@homelab/ui/identity/client";
import * as v from "valibot";

import { claimSignInRestart, restartSignIn } from "./restartSignIn";
/**
 * Complete the pending SSO or OIDC handoff and validate its return destination.
 * @param client - The authenticated browser identity client.
 * @param address - The current sign-in URL containing handoff parameters.
 * @returns A validated destination or the consent details awaiting an explicit decision.
 * @throws {Error} The server returns an unexpected or unsafe redirect destination.
 */
export async function signInDestination(
    client: IdentityClient,
    address: URL
): Promise<string | OidcConsent> {
    if (address.pathname === "/sso") {
        const target = address.searchParams.get("target");
        const nonce = address.searchParams.get("nonce");
        const result = v.parse(
            v.object({ redirect: v.string() }),
            await client.request("/api/sso/complete", { target, nonce })
        );
        const destination = new URL(result.redirect);
        if (
            !target ||
            destination.origin !== new URL(target).origin ||
            destination.pathname !== "/.homelab/sso/callback"
        )
            throw new Error("Invalid return address.");
        return destination.href;
    } else if (address.searchParams.has("interaction")) {
        let response: unknown;
        try {
            response = await client.request("/sign-in/complete", {});
        } catch (error) {
            if (
                error instanceof IdentityError &&
                error.code === "INTERACTION_EXPIRED" &&
                claimSignInRestart()
            )
                return restartSignIn(client, address);
            throw error;
        }
        const result = v.parse(oidcInteractionSchema, response);
        if ("consent" in result) return result.consent;
        const destination = new URL(result.redirect, address.origin);
        if (destination.origin !== address.origin)
            throw new Error("Invalid authorization return address.");
        return destination.href;
    } else return new URL("/account", address).href;
}
