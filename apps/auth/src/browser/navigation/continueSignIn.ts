import type { IdentityClient } from "@homelab/ui/identity/client";
import * as v from "valibot";
/**
 * Finish the pending SSO or OIDC handoff after validating its return destination.
 * @param client - The authenticated browser identity client.
 * @param address - The current sign-in URL containing handoff parameters.
 * @returns Completion after scheduling navigation.
 * @throws {Error} The server returns an unexpected or unsafe redirect destination.
 */
export async function continueSignIn(
    client: IdentityClient,
    address: URL
): Promise<void> {
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
        globalThis.location.assign(destination.href);
    } else if (address.searchParams.has("interaction")) {
        const result = v.parse(
            v.object({ redirect: v.string() }),
            await client.request("/sign-in/complete", {})
        );
        const destination = new URL(result.redirect, globalThis.location.origin);
        if (destination.origin !== globalThis.location.origin)
            throw new Error("Invalid authorization return address.");
        globalThis.location.assign(destination.href);
    } else globalThis.location.assign("/account");
}
