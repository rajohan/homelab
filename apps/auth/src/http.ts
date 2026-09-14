import { isIP } from "node:net";

export interface AuthServerOptions {
    readonly hostname?: string;
    readonly port?: number;
}

export function authBindOptions(
    environment: Readonly<Record<string, string | undefined>>
): { hostname: string; port: number } {
    const hostname = environment.HOMELAB_AUTH_HOST ?? "127.0.0.1";
    const rawPort = environment.HOMELAB_AUTH_PORT ?? "3101";
    if (isIP(hostname) === 0) throw new Error("HOMELAB_AUTH_HOST must be an IP address");
    if (!/^[1-9]\d{0,4}$/.test(rawPort) || Number(rawPort) > 65_535) {
        throw new Error("HOMELAB_AUTH_PORT must be between 1 and 65535");
    }
    return { hostname, port: Number(rawPort) };
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
