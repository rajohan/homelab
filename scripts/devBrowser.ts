import {
    createConnection,
    createServer,
    isIPv4,
    type Server,
    type Socket,
} from "node:net";
import { networkInterfaces } from "node:os";

function ipv4(value: string): bigint {
    if (!isIPv4(value)) throw new Error("Expected a Docker bridge IPv4 address.");
    return value.split(".").reduce((result, part) => (result << 8n) | BigInt(part), 0n);
}

/**
 * Forward the three fixed preview ports from one local Docker bridge to loopback.
 * @param address - Explicit bridge gateway shared with the provisioned browser proxy.
 * @returns Cleanup that closes every owned socket and listener; no LAN listener is opened.
 */
export async function startDevelopmentBrowserBridge(
    address: string
): Promise<() => Promise<void>> {
    const local = Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
        name.startsWith("br-") || name === "docker0"
            ? (entries ?? []).filter(
                  (entry) => entry.family === "IPv4" && entry.address === address
              )
            : []
    )[0];
    if (!local || local.internal)
        throw new Error(
            "Browser preview requires this host's Docker bridge gateway, not a LAN or wildcard address."
        );
    // Docker hairpin routing can present this host's LAN address even when
    // a local client binds the bridge address. Allow only exact local addresses.
    const hostAddresses = new Set(
        Object.values(networkInterfaces()).flatMap((entries) =>
            (entries ?? [])
                .filter((entry) => entry.family === "IPv4")
                .map((entry) => entry.address)
        )
    );
    const mask = ipv4(local.netmask);
    const subnet = ipv4(address) & mask;
    const servers: Server[] = [];
    const sockets = new Set<Socket>();
    let closing: Promise<void> | undefined;
    const close = () => {
        if (closing) return closing;
        for (const socket of sockets) socket.destroy();
        closing = (async () => {
            await Promise.all(
                servers.map(
                    (server) =>
                        new Promise<void>((resolve, reject) => {
                            if (!server.listening) {
                                resolve();
                                return;
                            }
                            server.close((error) => (error ? reject(error) : resolve()));
                        })
                )
            );
        })();
        return closing;
    };
    try {
        for (const port of [3100, 3101, 8400]) {
            const server = createServer((incoming) => {
                if (
                    !incoming.remoteAddress ||
                    !isIPv4(incoming.remoteAddress) ||
                    ((ipv4(incoming.remoteAddress) & mask) !== subnet &&
                        !hostAddresses.has(incoming.remoteAddress)) ||
                    sockets.size >= 64
                ) {
                    incoming.destroy();
                    return;
                }
                const outgoing = createConnection({ host: "127.0.0.1", port });
                for (const socket of [incoming, outgoing]) {
                    sockets.add(socket);
                    socket.once("close", () => {
                        sockets.delete(socket);
                        incoming.destroy();
                        outgoing.destroy();
                    });
                    socket.once("error", () => {
                        incoming.destroy();
                        outgoing.destroy();
                    });
                }
                incoming.pipe(outgoing);
                outgoing.pipe(incoming);
            });
            server.on("error", () => {
                void close().catch(() => {});
            });
            servers.push(server);
            server.maxConnections = 32;
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(port, address, () => {
                    server.removeListener("error", reject);
                    resolve();
                });
            });
        }
        return close;
    } catch (error) {
        await close();
        throw error;
    }
}
