import { dashboardBindOptions, dashboardDevelopment } from "./environment";
import {
    dashboardApiRequest,
    dashboardHealthResponse,
    dashboardNotFound,
    type DashboardServerOptions,
} from "./http";
import index from "./index.html";

export function startDashboardServer(options: DashboardServerOptions = {}) {
    const bindOptions = dashboardBindOptions();
    return Bun.serve({
        hostname: options.hostname ?? bindOptions.hostname,
        port: options.port ?? bindOptions.port,
        development: options.development ?? dashboardDevelopment(),
        routes: {
            "/health/live": { GET: dashboardHealthResponse },
            "/health/ready": { GET: dashboardHealthResponse },
            "/api/trpc": dashboardApiRequest,
            "/api/trpc/*": dashboardApiRequest,
            "/api": dashboardNotFound,
            "/api/*": dashboardNotFound,
            "/*": index,
        },
        fetch: dashboardNotFound,
    });
}

if (import.meta.main) {
    const server = startDashboardServer();
    process.stdout.write(
        `${JSON.stringify({ service: "dashboard", event: "listening", port: server.port })}\n`
    );
}
