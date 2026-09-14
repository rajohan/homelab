export interface AuthServerOptions {
    readonly hostname?: string;
    readonly port?: number;
}

const unavailableProtocolPrefixes = [
    "/authorize",
    "/token",
    "/userinfo",
    "/jwks",
    "/introspect",
    "/revoke",
    "/authz",
    "/api/authz",
    "/.well-known",
];

function json(payload: unknown, status = 200): Response {
    return Response.json(payload, {
        status,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
}

// A healthy process is not an operational identity provider. Protocol endpoints
// must not admit requests until the separate authentication phase is implemented.
export function authRequest(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (
        unavailableProtocolPrefixes.some(
            (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
        )
    ) {
        return json({ error: "Authentication provider is not implemented" }, 503);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "Not found" }, 404);
    }
    if (pathname === "/" || pathname === "/health/live" || pathname === "/health/ready") {
        return json({
            service: "auth",
            status: "ok",
            phase: "foundation",
            authenticationImplemented: false,
        });
    }
    return json({ error: "Not found" }, 404);
}
