import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { appRouter } from "./api";
import type { DashboardAuthConfiguration } from "./authConfiguration";

export interface DashboardServerOptions {
    readonly hostname?: string;
    readonly port?: number;
    readonly development?: boolean;
    readonly authentication?: DashboardAuthConfiguration | null;
}

export function dashboardHealthResponse(): Response {
    return Response.json(
        { service: "dashboard", phase: "identity", status: "ok" },
        { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }
    );
}

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

export function dashboardNotFound(): Response {
    return Response.json({ error: "Not found" }, { status: 404 });
}
