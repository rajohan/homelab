import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { browserDockerRequest } from "./docker";

test("local Docker transport bounds actual HTTP responses and deadlines without retrying mutations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-http-test-"));
    const socket = path.join(directory, "engine.sock");
    let calls = 0,
        received = "";
    const held: ServerResponse[] = [];
    const server = createServer((request, response) => {
        calls++;
        if (request.url === "/v1.45/success") {
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
                received += chunk;
            });
            request.on("end", () => {
                response.writeHead(201, { "content-type": "application/json" });
                response.end(JSON.stringify({ Id: "synthetic" }));
            });
        } else if (request.url === "/v1.45/empty") {
            response.writeHead(204);
            response.end();
        } else if (request.url === "/v1.45/invalid") response.end("not JSON");
        else if (request.url === "/v1.45/large")
            response.end(JSON.stringify({ data: "x".repeat(300_000) }));
        else if (request.url === "/v1.45/partial") {
            response.writeHead(200, { "content-length": "100" });
            response.write("{");
            response.destroy();
        } else held.push(response);
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const call = browserDockerRequest(socket, 100);
    try {
        expect(await call("POST", "/success", { Image: "fixture" })).toEqual({
            status: 201,
            body: { Id: "synthetic" },
        });
        expect(JSON.parse(received)).toEqual({ Image: "fixture" });
        expect(await call("DELETE", "/empty")).toEqual({ status: 204, body: null });
        for (const route of ["invalid", "large", "partial", "hang"])
            await assert.rejects(call("POST", `/${route}`), /did not complete/);
        expect(calls).toBe(6);
        for (const value of [0, 10_001, 0.5, Number.NaN])
            expect(() => browserDockerRequest(socket, value)).toThrow();
    } finally {
        for (const response of held) response.destroy();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        );
        await rm(directory, { recursive: true, force: true });
    }
    await assert.rejects(call("GET", "/missing"), /did not complete/);
});
