import type { ClientMetadata, Configuration } from "oidc-provider";

/**
 * Restrict OIDC requests to operator-registered logout endpoints without redirects.
 * @param clients - The static client inventory; request data cannot extend it.
 * @returns A bounded POST-only transport for the pinned provider.
 */
export function createOidcFetch(
    clients: readonly ClientMetadata[]
): NonNullable<Configuration["fetch"]> {
    const endpoints = new Set(
        clients.flatMap((client) =>
            client.backchannel_logout_uri
                ? [new URL(client.backchannel_logout_uri).href]
                : []
        )
    );
    return async (input, options) => {
        if (typeof input !== "string" && !(input instanceof URL))
            throw new Error("Outgoing OIDC request type is not registered");
        const url = new URL(input).href;
        if (options?.method !== "POST" || !endpoints.has(url))
            throw new Error("Outgoing OIDC endpoint is not registered");
        return fetch(url, {
            ...options,
            signal: AbortSignal.any([
                ...(options.signal ? [options.signal] : []),
                AbortSignal.timeout(5000),
            ]),
            redirect: "manual",
        });
    };
}
