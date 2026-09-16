import type { KoaContextWithOIDC } from "oidc-provider";

import type { Principal } from "../security/accounts";

const submit =
    'document.getElementById("op.logoutForm").requestSubmit(document.getElementById("confirm-logout"));';

/**
 * Finish a verified app-initiated logout without asking the user a second time.
 * @param context - Provider context after signature and redirect validation.
 * @param form - The provider-generated, CSRF-protected logout form.
 * @param principal - The current central identity, if still authenticated.
 * @returns The protected form response, submitted automatically only for a matching session.
 */
export function renderLogout(
    context: KoaContextWithOIDC,
    form: string,
    principal: Principal | undefined
): void {
    const { session, client, entities } = context.oidc;
    // The library validates this ID token before calling logoutSource. Bind it to
    // both current sessions as well: an old or different user's token is not consent.
    const hint = entities.IdTokenHint?.payload;
    const automatic = Boolean(
        principal &&
        client &&
        session?.accountId &&
        principal.user.id === session.accountId &&
        hint?.sub === session.accountId &&
        typeof hint.sid === "string" &&
        hint.sid === session.sidFor(client.clientId)
    );
    context.type = "html";
    if (automatic) {
        const hash = new Bun.CryptoHasher("sha256").update(submit).digest("base64");
        context.set(
            "Content-Security-Policy",
            `default-src 'none'; script-src 'sha256-${hash}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
        );
    }
    const title = automatic ? "Signing out" : "Sign out of Homelab?";
    const description = automatic
        ? "Finishing your sign-out. If you are not redirected, select Sign out."
        : "This ends this browser's identity session and its connected grants.";
    context.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><main><h1>${title}</h1><p>${description}</p>${form}<button id="confirm-logout" type="submit" form="op.logoutForm" name="logout" value="yes">Sign out</button>${automatic ? `<script>${submit}</script>` : '<p><a href="/account">Cancel</a></p>'}</main></html>`;
}
