import { isIP } from "node:net";

import type { ClientMetadata, JWKS } from "oidc-provider";
import { getDomain } from "tldts";
import * as v from "valibot";

const originSchema = v.pipe(v.string(), v.url(), v.maxLength(512));
const clientSchema = v.strictObject({
    client_id: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    client_secret: v.pipe(v.string(), v.minLength(32), v.maxLength(512)),
    client_name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    redirect_uris: v.pipe(v.array(originSchema), v.minLength(1), v.maxLength(8)),
    post_logout_redirect_uris: v.optional(v.array(originSchema), []),
    token_endpoint_auth_method: v.picklist(["client_secret_basic", "client_secret_post"]),
});
const routeSchema = v.strictObject({
    origin: originSchema,
    // Only exact paths or path-segment prefixes may bypass authentication.
    publicPaths: v.optional(v.array(v.pipe(v.string(), v.regex(/^\/(?!\/)/))), []),
    publicPrefixes: v.optional(
        v.array(v.pipe(v.string(), v.minLength(2), v.regex(/^\/(?!\/).*\/$/))),
        []
    ),
    groups: v.optional(v.array(v.pipe(v.string(), v.minLength(1))), ["admins"]),
});

export interface AuthConfiguration {
    readonly issuer: string;
    readonly dashboardOrigin: string;
    readonly databaseUrl: string;
    readonly development: boolean;
    readonly encryptionKey: Uint8Array;
    readonly cookieKey: string;
    readonly proxyKey: string;
    readonly rpId: string;
    readonly origins: readonly string[];
    readonly clients: readonly ClientMetadata[];
    readonly dashboardClientId: string;
    readonly jwks: JWKS;
    readonly routes: readonly v.InferOutput<typeof routeSchema>[];
    readonly resendKey: string | undefined;
    readonly emailFrom: string;
}

function parsedJson(value: string, name: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new Error(`Invalid JSON in ${name}`);
    }
}

function secureUrl(value: string, development: boolean, originOnly = false): URL {
    const url = new URL(value);
    const local =
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]";
    if (
        url.username ||
        url.password ||
        url.hash ||
        (originOnly && url.search) ||
        (url.protocol !== "https:" &&
            !(development && local && url.protocol === "http:")) ||
        (originOnly && url.pathname !== "/")
    ) {
        throw new Error(
            "Authentication URLs require HTTPS and an explicit trusted origin"
        );
    }
    return url;
}

export function parseAuthConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): AuthConfiguration | undefined {
    if (!environment.HOMELAB_AUTH_ISSUER) {
        if (environment.NODE_ENV === "production")
            throw new Error("HOMELAB_AUTH_ISSUER is required");
        return undefined;
    }
    const required = (name: string): string => {
        const value = environment[name];
        if (!value) throw new Error(`${name} is required`);
        return value;
    };
    const development =
        environment.NODE_ENV !== "production" &&
        environment.HOMELAB_AUTH_DEVELOPMENT === "true";
    const issuer = secureUrl(required("HOMELAB_AUTH_ISSUER"), development, true).origin;
    const dashboardOrigin = secureUrl(
        required("HOMELAB_AUTH_DASHBOARD_ORIGIN"),
        development,
        true
    ).origin;
    const rpId = required("HOMELAB_AUTH_RP_ID");
    if (
        isIP(rpId) !== 0 ||
        rpId.includes("/") ||
        rpId.includes(":") ||
        (!(development && rpId === "localhost") &&
            !getDomain(rpId, { allowPrivateDomains: true, extractHostname: false }))
    )
        throw new Error("Invalid WebAuthn RP ID");
    const origins = [issuer, dashboardOrigin];
    for (const origin of origins) {
        const hostname = new URL(origin).hostname;
        if (hostname !== rpId && !hostname.endsWith(`.${rpId}`))
            throw new Error("WebAuthn RP ID does not cover the approved UI origins");
    }
    const encryptionKey = Buffer.from(required("HOMELAB_AUTH_ENCRYPTION_KEY"), "base64");
    if (encryptionKey.length !== 32)
        throw new Error("The auth encryption key must contain 32 random bytes");
    const cookieKey = required("HOMELAB_AUTH_COOKIE_KEY");
    const proxyKey = required("HOMELAB_AUTH_PROXY_KEY");
    if (cookieKey.length < 43 || proxyKey.length < 43)
        throw new Error(
            "Auth signing and proxy keys must contain at least 256 bits of random material"
        );
    const clients = v.parse(
        v.pipe(v.array(clientSchema), v.minLength(1)),
        parsedJson(required("HOMELAB_AUTH_CLIENTS"), "HOMELAB_AUTH_CLIENTS")
    );
    const dashboardClientId = required("HOMELAB_AUTH_DASHBOARD_CLIENT_ID");
    if (
        new Set(clients.map((client) => client.client_id)).size !== clients.length ||
        !clients.some((client) => client.client_id === dashboardClientId)
    )
        throw new Error("Invalid OIDC client inventory");
    const dashboardClient = clients.find(
        (client) => client.client_id === dashboardClientId
    );
    if (!dashboardClient?.redirect_uris.includes(`${dashboardOrigin}/auth/callback`))
        throw new Error(
            "The dashboard client must register its exact /auth/callback URL"
        );
    for (const client of clients) {
        for (const uri of [...client.redirect_uris, ...client.post_logout_redirect_uris])
            secureUrl(uri, development);
    }
    const rawJwks = parsedJson(required("HOMELAB_AUTH_JWKS"), "HOMELAB_AUTH_JWKS");
    const jwks = v.parse(
        v.object({
            keys: v.pipe(v.array(v.record(v.string(), v.unknown())), v.minLength(1)),
        }),
        rawJwks
    ) as JWKS;
    if (!jwks.keys.every((key) => "kid" in key && key.kid && "d" in key && key.d))
        throw new Error("OIDC requires identified private signing keys");
    const routes = v.parse(
        v.array(routeSchema),
        parsedJson(environment.HOMELAB_AUTH_ROUTES ?? "[]", "HOMELAB_AUTH_ROUTES")
    );
    const normalizedRoutes = routes.map((route) => ({
        ...route,
        origin: secureUrl(route.origin, development, true).origin,
    }));
    if (
        new Set(normalizedRoutes.map((route) => route.origin)).size !==
        normalizedRoutes.length
    )
        throw new Error("Duplicate protected route origins");
    const databaseUrl = required("HOMELAB_AUTH_DATABASE_URL");
    if (!["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol))
        throw new Error("Auth requires PostgreSQL");
    const database = new URL(databaseUrl);
    if (!development && database.searchParams.get("sslmode") !== "verify-full")
        throw new Error("Production auth database requires sslmode=verify-full");
    const resendKey = environment.HOMELAB_AUTH_RESEND_API_KEY;
    if (!development && !resendKey)
        throw new Error("Resend delivery must be configured for production");
    const emailFrom = required("HOMELAB_AUTH_EMAIL_FROM");
    if (/[\r\n]/.test(emailFrom)) throw new Error("Invalid sender address");
    return {
        issuer,
        dashboardOrigin,
        databaseUrl,
        development,
        encryptionKey,
        cookieKey,
        proxyKey,
        rpId,
        origins,
        clients: clients.map((client) => ({
            ...client,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            scope:
                client.client_id === dashboardClientId
                    ? "openid profile email groups offline_access account"
                    : "openid profile email groups offline_access",
        })),
        dashboardClientId,
        jwks,
        routes: normalizedRoutes,
        resendKey,
        emailFrom,
    };
}
