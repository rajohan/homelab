import { request } from "node:http";
import { Duplex } from "node:stream";

import * as v from "valibot";

import { browserDockerFrames } from "./attach";
import { browserDockerRequest } from "./docker";

const idSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

/** Attach a fixed VNC server to the already-owned Chromium display over Docker's private pipe.
 * @param socketPath - Host-owned Docker socket.
 * @param containerId - Immutable container ID of the initialized session.
 * @param viewOnly - Enforced by the VNC server, independently of the web client's settings.
 * @param signal - Revocation of this viewer; no browser or TCP port is exposed.
 * @returns A binary RFB stream and completion after the fixed exec process exits.
 */
export async function openBrowserVnc(
    socketPath: string,
    containerId: string,
    viewOnly: boolean,
    signal: AbortSignal
) {
    v.parse(idSchema, containerId);
    signal.throwIfAborted();
    const docker = browserDockerRequest(socketPath);
    const created = await docker("POST", `/containers/${containerId}/exec`, {
        User: "1000:1000",
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: false,
        Tty: false,
        Cmd: [
            "/usr/bin/python3",
            "-I",
            "/opt/mira-browser/vnc.py",
            viewOnly ? "view" : "control",
        ],
    });
    if (created.status !== 201) throw new Error("Browser display could not be attached.");
    const execId = v.parse(v.object({ Id: idSchema }), created.body).Id;
    signal.throwIfAborted();
    const wire = await new Promise<Duplex>((resolve, reject) => {
        const body = JSON.stringify({ Detach: false, Tty: false });
        const outgoing = request({
            socketPath,
            method: "POST",
            path: `/v1.45/exec/${execId}/start`,
            headers: {
                Connection: "Upgrade",
                Upgrade: "tcp",
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
            },
        });
        let settled = false;
        const finish = () => {
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", fail);
        };
        const fail = () => {
            if (settled) return;
            finish();
            outgoing.destroy();
            reject(new Error("Browser display connection failed."));
        };
        const timer = setTimeout(fail, 30_000);
        outgoing.on("error", fail);
        outgoing.on("response", (response) => {
            response.destroy();
            fail();
        });
        outgoing.on("upgrade", (response, socket, head) => {
            if (settled || signal.aborted || response.statusCode !== 101) {
                socket.destroy();
                fail();
                return;
            }
            finish();
            if (head.length > 0) socket.unshift(head);
            resolve(socket);
        });
        signal.addEventListener("abort", fail, { once: true });
        if (signal.aborted) fail();
        else outgoing.end(body);
    });
    const stream = new Duplex({
        read() {
            wire.resume();
        },
        write(chunk, _encoding, callback) {
            wire.write(chunk, callback);
        },
        final(callback) {
            wire.end(callback);
        },
        destroy(error, callback) {
            // Deliver stdin EOF while draining the last framebuffer. Abruptly
            // dropping a backpressured Docker attach can leave exec input open.
            wire.end();
            wire.resume();
            callback(error);
        },
    });
    const decode = browserDockerFrames((bytes) => {
        if (!stream.destroyed && !stream.push(bytes)) wire.pause();
    });
    wire.on("data", (chunk: Buffer) => {
        try {
            decode(chunk);
        } catch {
            stream.destroy();
        }
    });
    wire.on("error", () => stream.destroy());
    wire.on("end", () => stream.push(null));
    wire.on("close", () => stream.destroy());
    const stop = () => stream.destroy();
    signal.addEventListener("abort", stop, { once: true });
    stream.once("close", () => signal.removeEventListener("abort", stop));
    if (signal.aborted) stop();
    return {
        stream,
        close: async () => {
            stream.destroy();
            // A controller handover waits for the input process to stop.
            for (let attempt = 0; attempt < 100; attempt++) {
                const result = await docker("GET", `/exec/${execId}/json`);
                if (result.status === 404) {
                    wire.destroy();
                    return;
                }
                if (result.status !== 200) break;
                if (!v.parse(v.object({ Running: v.boolean() }), result.body).Running) {
                    wire.destroy();
                    return;
                }
                await Bun.sleep(100);
            }
            wire.destroy();
            throw new Error("Browser display input did not stop.");
        },
    };
}
