import { request, type IncomingMessage } from "node:http";

export interface BrowserDockerResponse {
    status: number;
    body: unknown;
}
export type BrowserDockerRequest = (
    method: "GET" | "POST" | "DELETE",
    route: string,
    body?: unknown
) => Promise<BrowserDockerResponse>;

/**
 * Bind bounded Docker Engine requests to one trusted local Unix socket.
 * @param socketPath - Host-validated canonical socket; remote Docker endpoints are not accepted.
 * @param timeoutMs - Overall request deadline, at most ten seconds; shorter values support qualification.
 * @returns A host-only transport with a ten-second overall deadline and bounded JSON responses.
 */
export function browserDockerRequest(
    socketPath: string,
    timeoutMs = 10_000
): BrowserDockerRequest {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
        throw new Error(
            "Browser Docker deadline must be between one and ten thousand milliseconds."
        );
    return (method, route, body) =>
        new Promise((resolve, reject) => {
            const data = body === undefined ? undefined : JSON.stringify(body);
            let settled = false;
            const fail = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                response?.destroy();
                outgoing.destroy();
                reject(
                    new Error("The local browser container operation did not complete.")
                );
            };
            let response: IncomingMessage | undefined;
            const outgoing = request({
                socketPath,
                method,
                path: `/v1.45${route}`,
                headers: data
                    ? {
                          "content-type": "application/json",
                          "content-length": Buffer.byteLength(data),
                      }
                    : {},
            });
            const timer = setTimeout(fail, timeoutMs);
            outgoing.on("error", fail);
            outgoing.on("response", (incoming) => {
                if (settled) {
                    incoming.destroy();
                    return;
                }
                response = incoming;
                let bytes = 0;
                const chunks: Buffer[] = [];
                incoming.on("error", fail);
                incoming.on("aborted", fail);
                incoming.on("data", (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes > 256 * 1024) {
                        fail();
                        return;
                    }
                    chunks.push(chunk);
                });
                incoming.on("end", () => {
                    if (settled) return;
                    try {
                        const text = Buffer.concat(chunks).toString("utf8");
                        const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;
                        const status = incoming.statusCode;
                        if (!status) throw new Error("Missing Docker status.");
                        settled = true;
                        clearTimeout(timer);
                        resolve({ status, body: parsed });
                    } catch {
                        fail();
                    }
                });
            });
            outgoing.end(data);
        });
}
