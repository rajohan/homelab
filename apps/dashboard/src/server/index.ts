import index from "../index.html";
import { authenticateAutomation } from "./automation/authentication";
import {
    dashboardBindOptions,
    dashboardDevelopment,
    dashboardAuthConfiguration,
    dashboardOperationsConfiguration,
} from "./config/environment";
import { assertDashboardSchema } from "./database/migrations";
import { isSameOriginApiRequest } from "./http/requestOrigin";
import {
    dashboardApiRequest,
    dashboardHealthResponse,
    dashboardNotFound,
    type DashboardServerOptions,
} from "./http/responses";
import { createDashboardAuthentication } from "./identity/authentication";
import { OperationFailure } from "./operations/errors";
import { createOperationsRuntime } from "./operations/runtime";

/**
 * Start the dashboard HTTP server with identity-protected APIs and bundled assets.
 * @param options - Explicit listener and identity overrides for deployment or isolated tests.
 * @returns The running Bun server; the caller owns shutdown.
 */
export function startDashboardServer(options: DashboardServerOptions = {}) {
    const bindOptions = dashboardBindOptions();
    const configuration =
        options.authentication === undefined
            ? dashboardAuthConfiguration()
            : options.authentication;
    const authentication = configuration
        ? createDashboardAuthentication(configuration)
        : undefined;
    const operationalConfiguration =
        options.operations === undefined
            ? dashboardOperationsConfiguration()
            : options.operations;
    const operations = operationalConfiguration
        ? createOperationsRuntime(operationalConfiguration)
        : undefined;

    async function api(request: Request): Promise<Response> {
        try {
            const path = new URL(request.url).pathname;
            if (path === "/api/automation" || path.startsWith("/api/automation/")) {
                if (!operations)
                    return json(
                        "UNCONFIGURED",
                        "Dashboard operations are not configured.",
                        503
                    );
                if (request.headers.has("cookie") || request.headers.has("origin"))
                    return json(
                        "INVALID_CREDENTIALS",
                        "Use an automation token without browser credentials.",
                        403
                    );
                const principal = await authenticateAutomation(
                    operations.client,
                    request.headers.get("authorization") ?? ""
                );
                return await dashboardApiRequest(
                    request,
                    { operations, principal },
                    "/api/automation"
                );
            }
            if (path === "/health/ready") {
                if (operations) {
                    try {
                        await assertDashboardSchema(operations);
                    } catch {
                        return json(
                            "UNAVAILABLE",
                            "Dashboard database is not ready.",
                            503
                        );
                    }
                }
                return authentication
                    ? dashboardHealthResponse()
                    : json("UNCONFIGURED", "Identity is not configured.", 503);
            }
            if (!authentication)
                return json("UNCONFIGURED", "Identity is not configured.", 503);
            if (path === "/login" && request.method === "GET")
                return await authentication.begin(request);
            if (path === "/auth/callback" && request.method === "GET")
                return await authentication.callback(request);
            if (path === "/api/trpc" || path.startsWith("/api/trpc/")) {
                if (
                    !configuration ||
                    !isSameOriginApiRequest(request, configuration.origin)
                )
                    return json("INVALID_ORIGIN", "Request origin is not allowed.", 403);
                if (request.headers.has("authorization"))
                    return json(
                        "INVALID_CREDENTIALS",
                        "Use the automation endpoint for machine tokens.",
                        403
                    );
                const principal = await authentication.operationPrincipal(request);
                return await dashboardApiRequest(request, {
                    operations,
                    principal,
                    verifyHuman: () => authentication.operationPrincipal(request, true),
                });
            }
            return await authentication.proxy(request);
        } catch (error) {
            if (error instanceof OperationFailure) {
                const statuses = {
                    UNAUTHORIZED: 401,
                    TOO_MANY_REQUESTS: 429,
                    FORBIDDEN: 403,
                    BAD_REQUEST: 400,
                    CONFLICT: 409,
                    NOT_FOUND: 404,
                    PRECONDITION_FAILED: 412,
                } as const;
                return json(error.code, error.message, statuses[error.code]);
            }
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
    const server = Bun.serve({
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
            "/api/automation": api,
            "/api/automation/*": api,
            "/api": dashboardNotFound,
            "/api/*": api,
            "/*": index,
        },
        fetch: dashboardNotFound,
    });
    const stop = server.stop.bind(server);
    server.stop = async (closeActiveConnections?: boolean) => {
        await stop(closeActiveConnections);
        await operations?.client.close();
    };
    return server;
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
            JSON.stringify({
                service: "dashboard",
                event: "startup_failed",
                hint: "Check scoped identity configuration.",
            }) + "\n"
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
