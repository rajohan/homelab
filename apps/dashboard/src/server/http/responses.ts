import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { appRouter } from "../api/router";
import type { DashboardAuthConfiguration } from "../config/auth";

export interface DashboardServerOptions {
    readonly hostname?: string;
    readonly port?: number;
    readonly development?: boolean;
    readonly authentication?: DashboardAuthConfiguration | null;
}

/**
 * Report that the dashboard process can serve requests.
 * @returns A non-cacheable JSON health response.
 */
export function dashboardHealthResponse(): Response {
    return Response.json(
        { service: "dashboard", phase: "identity", status: "ok" },
        { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }
    );
}

/**
 * Dispatch an already authorized request to the dashboard tRPC router.
 * @param request - The request after the server's origin and session checks.
 * @returns The tRPC response with private-response caching disabled.
 */
export async function dashboardApiRequest(request: Request): Promise<Response> {
    const response = await fetchRequestHandler({
        endpoint: "/api/trpc",
        req: request,
        router: appRouter,
        createContext: () => ({}),
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
}

/**
 * Return the dashboard API's missing-resource response.
 * @returns A JSON 404 response.
 */
export function dashboardNotFound(): Response {
    return Response.json({ error: "Not found" }, { status: 404 });
}
