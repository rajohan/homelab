import { isIP } from "node:net";

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { appRouter } from "./api";

export interface DashboardServerOptions {
    readonly hostname?: string;
    readonly port?: number;
    readonly development?: boolean;
}

export function dashboardBindOptions(
    environment: Readonly<Record<string, string | undefined>>
): { hostname: string; port: number } {
    const hostname = environment.HOMELAB_DASHBOARD_HOST ?? "127.0.0.1";
    const rawPort = environment.HOMELAB_DASHBOARD_PORT ?? "3100";
    if (isIP(hostname) === 0)
        throw new Error("HOMELAB_DASHBOARD_HOST must be an IP address");
    if (!/^[1-9]\d{0,4}$/.test(rawPort) || Number(rawPort) > 65_535) {
        throw new Error("HOMELAB_DASHBOARD_PORT must be between 1 and 65535");
    }
    return { hostname, port: Number(rawPort) };
}

export function dashboardHealthResponse(): Response {
    return Response.json(
        { service: "dashboard", phase: "foundation", status: "ok" },
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
