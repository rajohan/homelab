import type { KoaContextWithOIDC } from "oidc-provider";

import type { Principal } from "../security/accounts";
import { logoutDocument, logoutStyleHash } from "./logoutDocument";

const submit =
    'const button=document.getElementById("confirm-logout");' +
    "button.form.requestSubmit(button);" +
    'document.getElementById("logout-controls").hidden=true;' +
    'document.getElementById("logout-progress").hidden=false;';

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
    const redirect = context.oidc.params?.post_logout_redirect_uri;
    const destination =
        typeof redirect === "string" && client?.postLogoutRedirectUriAllowed(redirect)
            ? ` ${new URL(redirect).origin}`
            : "";
    const scripts = automatic
        ? `'sha256-${new Bun.CryptoHasher("sha256").update(submit).digest("base64")}'`
        : "'none'";
    // Chromium also checks the form's redirect. Permit only this client's
    // validated return origin, never a wildcard or an unregistered destination.
    context.set(
        "Content-Security-Policy",
        `default-src 'none'; script-src ${scripts}; style-src 'sha256-${logoutStyleHash}'; img-src data:; form-action 'self'${destination}; frame-ancestors 'none'; base-uri 'none'`
    );
    context.body = logoutDocument(
        automatic ? "finishing" : "confirm",
        form,
        automatic ? submit : undefined
    );
}
