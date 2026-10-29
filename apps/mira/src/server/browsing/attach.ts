import { request } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Attach private stdin/stdout to one already-created container before it starts.
 * @param socketPath - Canonical local Engine socket validated by the container lease.
 * @param id - Immutable ID returned by that lease, never a model-selected target.
 * @param signal - Permanent cancellation during the bounded upgrade handshake.
 * @returns A private upgraded stream; its owner must destroy it and close the container lease.
 */
export function attachBrowserContainer(
    socketPath: string,
    id: string,
    signal: AbortSignal
): Promise<Duplex> {
    signal.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid browser container ID.");
    return new Promise((resolve, reject) => {
        let settled = false;
        const outgoing = request({
            socketPath,
            method: "POST",
            path: `/v1.45/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=0`,
            headers: { Connection: "Upgrade", Upgrade: "tcp" },
        });
        const finish = () => {
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", fail);
        };
        const fail = () => {
            if (settled) return;
            finish();
            outgoing.destroy();
            reject(new Error("The private browser connection could not be attached."));
        };
        const timer = setTimeout(fail, 10_000);
        outgoing.on("error", fail);
        outgoing.on("response", (response) => {
            response.destroy();
            fail();
        });
        outgoing.on("upgrade", (response, socket, head) => {
            if (
                settled ||
                signal.aborted ||
                response.statusCode !== 101 ||
                response.headers.upgrade?.toLowerCase() !== "tcp"
            ) {
                socket.destroy();
                fail();
                return;
            }
            finish();
            // Preserve bytes received alongside the upgrade, before a consumer is attached.
            if (head.length > 0) socket.unshift(head);
            resolve(socket);
        });
        signal.addEventListener("abort", fail, { once: true });
        if (signal.aborted) fail();
        else outgoing.end();
    });
}

/**
 * Decode Docker's non-TTY stdout framing without retaining unbounded frame bodies.
 * @param receive - Synchronous consumer that enforces the application message limit.
 * @returns A streaming decoder; malformed headers throw and must retire the connection.
 */
export function browserDockerFrames(
    receive: (bytes: Buffer, frameComplete: boolean) => void
) {
    const header = Buffer.alloc(8);
    let used = 0;
    let remaining = 0;
    return (chunk: Buffer) => {
        let offset = 0;
        while (offset < chunk.length) {
            if (remaining === 0) {
                const length = Math.min(8 - used, chunk.length - offset);
                chunk.copy(header, used, offset, offset + length);
                used += length;
                offset += length;
                if (used < 8) return;
                remaining = header.readUInt32BE(4);
                if (
                    header[0] !== 1 ||
                    header[1] !== 0 ||
                    header[2] !== 0 ||
                    header[3] !== 0 ||
                    remaining < 1 ||
                    remaining > 4 * 1024 * 1024
                )
                    throw new Error("Invalid browser stream framing.");
                used = 0;
            }
            const length = Math.min(remaining, chunk.length - offset);
            if (length)
                receive(chunk.subarray(offset, offset + length), length === remaining);
            remaining -= length;
            offset += length;
        }
    };
}
