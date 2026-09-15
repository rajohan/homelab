import type { ClientMetadata, Configuration } from "oidc-provider";

// Only operator-registered logout endpoints may receive outgoing OIDC requests.
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
