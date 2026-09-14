import { createDashboardAuthentication } from "./authentication";
import {
    dashboardBindOptions,
    dashboardDevelopment,
    dashboardAuthConfiguration,
} from "./environment";
import {
    dashboardApiRequest,
    dashboardHealthResponse,
    dashboardNotFound,
    type DashboardServerOptions,
} from "./http";
import index from "./index.html";

export function startDashboardServer(options: DashboardServerOptions = {}) {
    const bindOptions = dashboardBindOptions();
    const configuration =
        options.authentication === undefined
            ? dashboardAuthConfiguration()
            : options.authentication;
    const authentication = configuration
        ? createDashboardAuthentication(configuration)
        : undefined;

    async function api(request: Request): Promise<Response> {
        try {
            const path = new URL(request.url).pathname;
            if (path === "/health/ready")
                return authentication
                    ? dashboardHealthResponse()
                    : json("UNCONFIGURED", "Identity is not configured.", 503);
            if (!authentication)
                return json("UNCONFIGURED", "Identity is not configured.", 503);
            if (path === "/login" && request.method === "GET")
                return await authentication.begin(request);
            if (path === "/auth/callback" && request.method === "GET")
                return await authentication.callback(request);
            if (path === "/api/trpc" || path.startsWith("/api/trpc/")) {
                if (!(await authentication.authenticated(request)))
                    return json("UNAUTHORIZED", "Sign in to continue.", 401);
                if (
                    request.method !== "GET" &&
                    request.headers.get("origin") !== configuration?.origin
                )
                    return json("INVALID_ORIGIN", "Request origin is not allowed.", 403);
                return await dashboardApiRequest(request);
            }
            return await authentication.proxy(request);
        } catch (error) {
            process.stderr.write(
                JSON.stringify({
                    service: "dashboard",
                    event: "identity_request_failed",
                    kind: error instanceof Error ? error.name : "Unknown",
                    upstreamStatus:
                        error instanceof Error && error.cause instanceof Response
                            ? error.cause.status
                            : undefined,
                    code:
                        typeof error === "object" &&
                        error !== null &&
                        "code" in error &&
                        typeof error.code === "string" &&
                        /^[A-Z_]{1,80}$/.test(error.code)
                            ? error.code
                            : undefined,
                }) + "\n"
            );
            return json(
                "IDENTITY_UNAVAILABLE",
                "Identity could not be verified. Start sign-in again or try later.",
                503
            );
        }
    }
    for (const asset of index.files ?? [])
        Object.assign(asset.headers, {
            "content-security-policy":
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            ...(asset.loader === "html" ? { "cache-control": "no-store" } : {}),
        });
    return Bun.serve({
        hostname: options.hostname ?? bindOptions.hostname,
        port: options.port ?? bindOptions.port,
        development: options.development ?? dashboardDevelopment(),
        maxRequestBodySize: 65_536,
        routes: {
            "/health/live": { GET: dashboardHealthResponse },
            "/health/ready": api,
            "/login": api,
            "/auth/callback": api,
            "/api/trpc": api,
            "/api/trpc/*": api,
            "/api": dashboardNotFound,
            "/api/*": api,
            "/*": index,
        },
        fetch: dashboardNotFound,
    });
}
if (import.meta.main) {
    try {
        const server = startDashboardServer();
        process.stdout.write(
            `${JSON.stringify({ service: "dashboard", event: "listening", port: server.port })}\n`
        );
        const stop = () => {
            void server.stop();
        };
        process.on("SIGTERM", stop);
        process.on("SIGINT", stop);
    } catch {
        process.stderr.write(
            String.raw`{"service":"dashboard","event":"startup_failed","hint":"Check scoped identity configuration."}\n`
        );
        process.exitCode = 1;
    }
}

const json = (code: string, message: string, status: number) =>
    Response.json(
        { code, message },
        {
            status,
            headers: {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        }
    );
