import { authBindOptions } from "./environment";
import { authRequest, type AuthServerOptions } from "./http";

export function startAuthServer(options: AuthServerOptions = {}) {
    const bindOptions = authBindOptions();
    return Bun.serve({
        hostname: options.hostname ?? bindOptions.hostname,
        port: options.port ?? bindOptions.port,
        fetch: authRequest,
    });
}

if (import.meta.main) {
    const server = startAuthServer();
    process.stdout.write(
        `${JSON.stringify({ service: "auth", event: "listening", port: server.port })}\n`
    );
}
