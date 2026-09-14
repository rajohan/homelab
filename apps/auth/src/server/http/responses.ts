import type { AuthConfiguration } from "../config/configuration";
import type { EmailDelivery } from "../security/email";
export interface AuthServerOptions {
    readonly hostname?: string;
    readonly port?: number;
    readonly delivery?: EmailDelivery;
    readonly configuration?: AuthConfiguration | null;
}
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
