import { timingSafeEqual } from "node:crypto";

import type { AuthConfiguration } from "../config/configuration";
import { AuthFailure } from "../security/errors";

/**
 * Choose the secure host-only session name, or its loopback development variant.
 * @param configuration - The identity deployment settings.
 * @returns The session cookie name.
 */
export function cookieName(configuration: AuthConfiguration): string {
    return configuration.development ? "homelab_auth" : "__Host-homelab_auth";
}

/**
 * Read a single unambiguous identity cookie from the incoming header.
 * @param header - The raw Cookie header, if present.
 * @param configuration - The identity deployment settings.
 * @returns The cookie value, or undefined when missing or ambiguous.
 */
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

/**
 * Serialize a host-only identity session cookie or expire it explicitly.
 * @param configuration - The identity deployment settings.
 * @param token - The opaque session token.
 * @param clear - Whether to expire the cookie instead of setting it.
 * @param remember - Whether this newly created session uses the extended lifetime.
 * @returns The Set-Cookie header value.
 */
export function sessionCookie(
    configuration: AuthConfiguration,
    token: string,
    clear = false,
    remember = false
): string {
    const maximum = remember
        ? configuration.sessionPolicy.rememberMaximumSeconds
        : configuration.sessionPolicy.maximumSeconds;
    return `${cookieName(configuration)}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : maximum}${configuration.development ? "" : "; Secure"}`;
}

/**
 * Verify the shared ForwardAuth proxy key using a constant-time byte comparison.
 * @param request - The incoming proxy request.
 * @param configuration - Settings containing the expected proxy key.
 * @returns Whether the presented key matches.
 */
export function trustedProxy(
    request: Request,
    configuration: AuthConfiguration
): boolean {
    const supplied = Buffer.from(request.headers.get("x-homelab-proxy-key") ?? "");
    const expected = Buffer.from(configuration.proxyKey);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Require an explicitly allowed origin and JSON content type for mutations.
 * @param request - The incoming mutation request.
 * @param configuration - Settings containing the allowed origins.
 * @returns The validated request origin.
 */
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

/**
 * Serialize a private JSON response with cache and content-sniffing protections.
 * @param value - The response payload.
 * @param status - The HTTP status; defaults to success.
 * @returns The protected JSON response.
 */
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
