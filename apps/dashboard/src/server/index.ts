import type { Server } from "bun";

import index from "../index.html";
import { authenticateAutomation } from "./automation/authentication";
import { privateComputerAddress } from "./config/computer";
import {
    dashboardAuthConfiguration,
    dashboardBindOptions,
    dashboardComputerBinding,
    dashboardDevelopment,
    dashboardOperationsConfiguration,
} from "./config/environment";
import { assertDashboardSchema } from "./database/migrations";
import { dashboardAppIcon } from "./http/appIcon";
import { boundedDashboardRequest, dashboardTransportBodyLimit } from "./http/requestBody";
import { isSameOriginApiRequest } from "./http/requestOrigin";
import {
    dashboardApiRequest,
    dashboardHealthResponse,
    dashboardNotFound,
    type DashboardServerOptions,
} from "./http/responses";
import { createDashboardAuthentication } from "./identity/authentication";
import { agentMailReceiverHeartbeat, agentMailWebhookReceiver } from "./mira/agentmail";
import {
    browserDisplayHandlers,
    type BrowserDisplaySocket,
    prepareBrowserDisplay,
} from "./mira/browserDisplay";
import {
    computerRequestMaximumBytes,
    miraComputerReceiver,
} from "./mira/computerReceiver";
import { miraFileRequest } from "./mira/files";
import { OperationFailure } from "./operations/errors";
import { createOperationsRuntime } from "./operations/runtime";

/**
 * Start the dashboard HTTP server with identity-protected APIs and bundled assets.
 * @param options - Explicit listener and identity overrides for deployment or isolated tests.
 * @returns The running Bun server; the caller owns shutdown.
 */
export function startDashboardServer(options: DashboardServerOptions = {}) {
    const bindOptions = dashboardBindOptions();
    const development = options.development ?? dashboardDevelopment();
    const hostname = options.hostname ?? bindOptions.hostname;
    if (
        options.impeccableLive &&
        (!development || !["127.0.0.1", "localhost", "::1"].includes(hostname))
    )
        throw new Error("Impeccable Live requires a loopback development server.");
    const liveSource = options.impeccableLive ? " http://localhost:8400" : "";
    const computerBinding =
        options.computerBinding === undefined
            ? dashboardComputerBinding()
            : options.computerBinding;
    if (computerBinding) privateComputerAddress(computerBinding.hostname);
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

    let computerServer: ReturnType<typeof Bun.serve> | undefined;
    const receiveAgentMail = agentMailWebhookReceiver(operations);
    const stopAgentMailHeartbeat = agentMailReceiverHeartbeat(operations);

    async function api(
        incoming: Request,
        host: Server<BrowserDisplaySocket>
    ): Promise<Response | undefined> {
        try {
            const incomingPath = new URL(incoming.url).pathname;
            if (incomingPath === "/api/mira/browser/display") {
                if (
                    !authentication ||
                    !configuration ||
                    incoming.method !== "GET" ||
                    incoming.headers.get("origin") !== configuration.origin ||
                    incoming.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
                    incoming.headers.has("authorization")
                )
                    return json(
                        "FORBIDDEN",
                        "Browser display requires a same-origin session.",
                        403
                    );
                const principal = await authentication.operationPrincipal(incoming);
                const data = await prepareBrowserDisplay(incoming, {
                    operations,
                    principal,
                    verifyHuman: () => authentication.operationPrincipal(incoming, true),
                });
                return host.upgrade(incoming, { data })
                    ? undefined
                    : json("UNAVAILABLE", "Browser display could not connect.", 503);
            }
            if (
                incomingPath === "/api/mira/computers" ||
                incomingPath.startsWith("/api/mira/computers/")
            )
                return json("NOT_FOUND", "Not found.", 404);
            if (incomingPath === "/api/mira/hooks/agentmail")
                return await receiveAgentMail(incoming);
            if (
                incomingPath === "/api/mira/files" ||
                incomingPath.startsWith("/api/mira/files/")
            ) {
                if (!authentication || !configuration)
                    return json("UNCONFIGURED", "Identity is not configured.", 503);
                if (!isSameOriginApiRequest(incoming, configuration.origin))
                    return json("INVALID_ORIGIN", "Request origin is not allowed.", 403);
                if (incoming.headers.has("authorization"))
                    return json(
                        "INVALID_CREDENTIALS",
                        "Mira files require a browser session.",
                        403
                    );
                const principal = await authentication.operationPrincipal(incoming);
                return await miraFileRequest(incoming, { operations, principal });
            }
            const request = await boundedDashboardRequest(incoming);
            if (!request)
                return json(
                    "PAYLOAD_TOO_LARGE",
                    "Request body exceeds its size limit.",
                    413
                );
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
            "content-security-policy": `default-src 'self'; script-src 'self'${liveSource}; style-src 'self' 'unsafe-inline'; img-src 'self' data:${options.impeccableLive ? " blob:" : ""}; connect-src 'self'${liveSource}; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'`,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            ...(asset.loader === "html" ? { "cache-control": "no-store" } : {}),
        });
    const server = Bun.serve<BrowserDisplaySocket>({
        hostname,
        port: options.port ?? bindOptions.port,
        development,
        maxRequestBodySize: dashboardTransportBodyLimit,
        routes: {
            "/app-icon.svg": dashboardAppIcon,
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
        websocket: browserDisplayHandlers,
    });
    const stop = server.stop.bind(server);
    server.stop = async (closeActiveConnections?: boolean) => {
        await Promise.all([
            stop(closeActiveConnections),
            computerServer?.stop(closeActiveConnections),
        ]);
        await stopAgentMailHeartbeat();
        await operations?.client.close();
    };
    try {
        if (computerBinding) {
            if (!authentication || !operations)
                throw new Error(
                    "Computer connectivity requires identity and operations."
                );
            computerServer = Bun.serve({
                ...computerBinding,
                development: false,
                maxRequestBodySize: computerRequestMaximumBytes,
                fetch: miraComputerReceiver(
                    operations.client,
                    operations.releaseRepository
                ),
            });
        }
    } catch (error) {
        void server.stop(true).catch(() => null);
        throw error;
    }
    return Object.assign(server, { computerPort: computerServer?.port ?? null });
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
