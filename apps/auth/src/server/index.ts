import index from "../index.html";
import { createAuthApplication } from "./application";
import {
    authBindOptions,
    authConfiguration,
    authDevelopment,
} from "./config/environment";
import { authRequest, type AuthServerOptions } from "./http/responses";

/**
 * Start the auth HTTP server and its configured identity application.
 * @param options - Listener, configuration and mail-delivery overrides for deployment or tests.
 * @returns The server and application handles required for controlled shutdown.
 */
export async function startAuthServer(options: AuthServerOptions = {}) {
    const bindOptions = authBindOptions();
    const configuration =
        options.configuration === undefined
            ? await authConfiguration()
            : options.configuration;
    const application = configuration
        ? await createAuthApplication(configuration, options.delivery)
        : undefined;
    for (const asset of index.files ?? [])
        Object.assign(asset.headers, {
            "content-security-policy":
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            ...(asset.loader === "html" ? { "cache-control": "no-store" } : {}),
        });
    let server: ReturnType<typeof Bun.serve>;
    try {
        server = Bun.serve({
            hostname: options.hostname ?? bindOptions.hostname,
            port: options.port ?? bindOptions.port,
            development: authDevelopment(),
            maxRequestBodySize: 65_536,
            routes: {
                "/": application ? index : authRequest,
                "/sign-in": application ? index : authRequest,
                "/account": application ? index : authRequest,
                "/sso": application ? index : authRequest,
                "/verify-email": application ? index : authRequest,
                "/forgot-password": application ? index : authRequest,
                "/reset-password": application ? index : authRequest,
            },
            fetch: (request, instance) =>
                application
                    ? application.handle(
                          request,
                          instance.requestIP(request)?.address ?? "unknown"
                      )
                    : authRequest(request),
        });
    } catch (error) {
        await application?.close();
        throw error;
    }
    const timer = application
        ? setInterval(() => {
              void application.maintain().catch(() => {
                  process.stderr.write(
                      JSON.stringify({ service: "auth", event: "maintenance_failed" }) +
                          "\n"
                  );
              });
          }, 15_000)
        : undefined;
    timer?.unref();
    return {
        port: server.port,
        stop: async () => {
            clearInterval(timer);
            await server.stop(true);
            await application?.close();
        },
    };
}
if (import.meta.main) {
    try {
        const server = await startAuthServer();
        process.stdout.write(
            `${JSON.stringify({ service: "auth", event: "listening", port: server.port })}\n`
        );
        let stopping = false;
        const stop = () => {
            if (stopping) return;
            stopping = true;
            void server.stop().catch(() => {
                process.exitCode = 1;
            });
        };
        process.on("SIGTERM", stop);
        process.on("SIGINT", stop);
    } catch {
        process.stderr.write(
            String.raw`{"service":"auth","event":"startup_failed","hint":"Check configuration and database readiness without printing secret values."}\n`
        );
        process.exitCode = 1;
    }
}
