import index from "./index.html";
import {
    dashboardApiRequest,
    dashboardBindOptions,
    dashboardHealthResponse,
    dashboardNotFound,
    type DashboardServerOptions,
} from "./http";

export function startDashboardServer(options: DashboardServerOptions = {}) {
    const bindOptions = dashboardBindOptions(process.env);
    return Bun.serve({
        hostname: options.hostname ?? bindOptions.hostname,
        port: options.port ?? bindOptions.port,
        development: options.development ?? process.env.NODE_ENV !== "production",
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
