import type { AuthConfiguration } from "../config/configuration";
import { clientAllowed } from "./clientAccess";

/**
 * Select a registered application's entry point, never reuse expired protocol state or codes.
 * @param configuration - Validated OIDC clients and dashboard origin.
 * @param clientId - The public client hint from the login page; it conveys no authority.
 * @param groups - Current authenticated account groups.
 * @returns A trusted application root or the account entry point when the hint is unavailable.
 */
export function signInRestartTarget(
    configuration: Pick<AuthConfiguration, "issuer" | "clients" | "clientGroups">,
    clientId: string | null,
    groups: readonly string[]
): string {
    const fallback = new URL("/account", configuration.issuer).href;
    if (!clientId || !clientAllowed(configuration, groups, clientId)) return fallback;
    const client = configuration.clients.find((item) => item.client_id === clientId);
    const origins = new Set(client?.redirect_uris?.map((uri) => new URL(uri).origin));
    // Multi-origin clients cannot safely infer which application initiated this request.
    if (origins.size !== 1) return fallback;
    const origin = [...origins][0];
    if (!origin || origin === configuration.issuer) return fallback;
    return new URL("/", origin).href;
}
