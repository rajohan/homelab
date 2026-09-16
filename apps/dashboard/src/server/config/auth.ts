export interface DashboardAuthConfiguration {
    readonly issuer: string;
    readonly origin: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly tokenEndpointAuthMethod: "client_secret_post" | "client_secret_basic";
    readonly sessionKey: Uint8Array;
    readonly development: boolean;
}

/**
 * Validate dashboard OIDC, origin and cookie-key settings before startup.
 * @param environment - The scoped dashboard environment values.
 * @returns Validated settings, or undefined only when identity is omitted in development.
 * @throws {Error} Production identity settings, client authentication mode, origins or key material are invalid.
 */
export function parseDashboardAuthConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): DashboardAuthConfiguration | undefined {
    if (!environment.HOMELAB_DASHBOARD_AUTH_ISSUER) {
        if (environment.NODE_ENV === "production")
            throw new Error("HOMELAB_DASHBOARD_AUTH_ISSUER is required");
        return undefined;
    }
    const required = (name: string): string => {
        const value = environment[name];
        if (!value) throw new Error(`${name} is required`);
        return value;
    };
    const development =
        environment.NODE_ENV !== "production" &&
        environment.HOMELAB_DASHBOARD_AUTH_DEVELOPMENT === "true";
    const origin = (value: string): string => {
        const url = new URL(value);
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (
            url.pathname !== "/" ||
            url.search ||
            url.hash ||
            url.username ||
            url.password ||
            (url.protocol !== "https:" &&
                !(development && loopback && url.protocol === "http:"))
        )
            throw new Error("Dashboard identity URLs require explicit HTTPS origins");
        return url.origin;
    };
    const sessionKey = Buffer.from(required("HOMELAB_DASHBOARD_SESSION_KEY"), "base64");
    if (sessionKey.length !== 32)
        throw new Error("Dashboard session key must contain 32 random bytes");
    const tokenEndpointAuthMethod =
        environment.HOMELAB_DASHBOARD_OIDC_AUTH_METHOD ?? "client_secret_post";
    if (
        tokenEndpointAuthMethod !== "client_secret_post" &&
        tokenEndpointAuthMethod !== "client_secret_basic"
    )
        throw new Error("Unsupported dashboard OIDC client authentication method");
    return {
        issuer: origin(required("HOMELAB_DASHBOARD_AUTH_ISSUER")),
        origin: origin(required("HOMELAB_DASHBOARD_ORIGIN")),
        clientId: required("HOMELAB_DASHBOARD_OIDC_CLIENT_ID"),
        clientSecret: required("HOMELAB_DASHBOARD_OIDC_CLIENT_SECRET"),
        sessionKey,
        tokenEndpointAuthMethod,
        development,
    };
}
