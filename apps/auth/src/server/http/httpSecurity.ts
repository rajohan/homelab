import { timingSafeEqual } from "node:crypto";

import type { AuthConfiguration } from "../config/configuration";
import { AuthFailure } from "../security/errors";

export function cookieName(configuration: AuthConfiguration): string {
    return configuration.development ? "homelab_auth" : "__Host-homelab_auth";
}

export function readAuthCookie(
    header: string | null | undefined,
    configuration: AuthConfiguration
): string | undefined {
    const prefix = `${cookieName(configuration)}=`;
    const matches = (header ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(prefix));
    if (matches.length !== 1) return undefined;
    const value = matches[0]?.slice(prefix.length);
    return value && /^[\w-]{43}$/.test(value) ? value : undefined;
}

export function sessionCookie(
    configuration: AuthConfiguration,
    token: string,
    clear = false
): string {
    return `${cookieName(configuration)}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 43_200}${configuration.development ? "" : "; Secure"}`;
}

export function trustedProxy(
    request: Request,
    configuration: AuthConfiguration
): boolean {
    const supplied = Buffer.from(request.headers.get("x-homelab-proxy-key") ?? "");
    const expected = Buffer.from(configuration.proxyKey);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function assertMutationOrigin(
    request: Request,
    configuration: AuthConfiguration
): string {
    const origin = request.headers.get("origin");
    if (!origin || !configuration.origins.includes(origin))
        throw new AuthFailure("INVALID_ORIGIN", 403, "Request origin is not allowed.");
    if (
        request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
    ) {
        throw new AuthFailure("INVALID_CONTENT_TYPE", 415, "JSON is required.");
    }
    return origin;
}

export function secureJson(value: unknown, status = 200): Response {
    return Response.json(value, {
        status,
        headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        },
    });
}
