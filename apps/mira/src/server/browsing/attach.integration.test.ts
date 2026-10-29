import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import { attachBrowserContainer } from "./attach";

test("private Docker upgrade preserves initial bytes and never redirects or retries", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-attach-test-"));
    const socketPath = path.join(directory, "engine.sock");
    const id = "a".repeat(64);
    let mode = "upgrade",
        calls = 0;
    const sockets = new Set<Duplex>();
    const server = createServer();
    server.on("upgrade", (request, socket) => {
        calls++;
        sockets.add(socket);
        socket.on("error", () => {});
        expect(request.method).toBe("POST");
        expect(request.url).toBe(
            `/v1.45/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=0`
        );
        if (mode === "upgrade") {
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\ninitial"
            );
            socket.on("data", (chunk) => socket.write(chunk));
        } else if (mode === "wrong")
            socket.end(
                "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
            );
        else if (mode === "redirect")
            socket.end(
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/forbidden\r\nContent-Length: 0\r\n\r\n"
            );
        else if (mode === "closed") socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
        const signal = new AbortController().signal;
        const stream = await attachBrowserContainer(socketPath, id, signal);
        const received = new Promise<string>((resolve) => {
            let text = "";
            stream.on("data", (chunk) => {
                text += String(chunk);
                if (text === "initialrequest") resolve(text);
            });
        });
        stream.write("request");
        expect(await received).toBe("initialrequest");
        stream.destroy();
        for (const failure of ["wrong", "redirect", "closed", "hang"]) {
            mode = failure;
            const owner = new AbortController();
            const attempt = assert.rejects(
                attachBrowserContainer(socketPath, id, owner.signal),
                /could not be attached/
            );
            if (failure === "hang") setTimeout(() => owner.abort(), 20);
            await attempt;
        }
        expect(calls).toBe(5);
        expect(() =>
            attachBrowserContainer(socketPath, "untrusted/name", signal)
        ).toThrow();
        expect(() =>
            attachBrowserContainer(socketPath, id, AbortSignal.abort())
        ).toThrow();
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        );
        await rm(directory, { recursive: true, force: true });
    }
    await assert.rejects(
        attachBrowserContainer(socketPath, id, new AbortController().signal)
    );
});
