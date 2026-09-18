import type { IdentityClient } from "@homelab/ui/identity/client";
import * as v from "valibot";

const attemptKey = "homelab.sign-in-restart";

/**
 * Allow one automatic recovery per minute across full-page navigations, preventing redirect loops.
 * @returns Whether safe browser storage permits this automatic attempt.
 */
export function claimSignInRestart(): boolean {
    try {
        const now = Date.now();
        const previous = Number(sessionStorage.getItem(attemptKey));
        if (previous > 0 && now - previous < 60_000) return false;
        sessionStorage.setItem(attemptKey, String(now));
        return true;
    } catch {
        return false;
    }
}

/**
 * Ask the authenticated server to choose a fresh app entry point after an expired interaction.
 * @param client - The same-origin identity client carrying the current authenticated session.
 * @param address - The login URL; its client hint is validated against registered server metadata.
 * @returns A server-approved destination without expired state, nonce, codes or credentials.
 */
export async function restartSignIn(
    client: IdentityClient,
    address: URL
): Promise<string> {
    const result = v.parse(
        v.object({ redirect: v.string() }),
        await client.request("/api/sign-in/restart", {
            clientId: address.searchParams.get("client"),
        })
    );
    const destination = new URL(result.redirect);
    if (
        destination.username ||
        destination.password ||
        destination.search ||
        destination.hash ||
        (destination.protocol !== "https:" &&
            !(
                address.protocol === "http:" &&
                destination.protocol === "http:" &&
                destination.hostname === address.hostname
            )) ||
        (destination.pathname !== "/" &&
            !(
                destination.origin === address.origin &&
                destination.pathname === "/account"
            ))
    ) {
        throw new Error("Invalid sign-in restart address.");
    }
    return destination.href;
}
