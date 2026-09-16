import type { AuthConfiguration } from "../config/configuration";
import type { EmailDelivery } from "../security/email";
export interface AuthServerOptions {
    readonly hostname?: string;
    readonly port?: number;
    readonly delivery?: EmailDelivery;
    readonly configuration?: AuthConfiguration | null;
}
/**
 * Serve only liveness successfully when the auth application is not configured.
 * @param request - The incoming health request.
 * @returns A non-cacheable liveness response or an unconfigured 503 response.
 */
export function authRequest(request: Request): Response {
    const live = new URL(request.url).pathname === "/health/live";
    return Response.json(
        {
            service: "auth",
            status: live ? "ok" : "unconfigured",
            authenticationImplemented: true,
        },
        {
            status: live ? 200 : 503,
            headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        }
    );
}
