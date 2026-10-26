import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ComputerCompanion, ComputerConnectionError } from "./companion";
import { issueComputerCredential } from "./credentials";

const signal = () => new AbortController().signal;

test("real HTTPS companion validates certificates, refuses redirects and aborts stalled bodies", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-computer-tls-"));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
        const child = Bun.spawn(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-noenc",
                "-subj",
                "/CN=127.0.0.1",
                "-addext",
                "subjectAltName=IP:127.0.0.1",
                "-days",
                "1",
                "-keyout",
                path.join(directory, "key.pem"),
                "-out",
                path.join(directory, "cert.pem"),
            ],
            { stdout: "ignore", stderr: "ignore" }
        );
        const deadline = setTimeout(() => child.kill(), 10_000);
        try {
            expect(await child.exited).toBe(0);
        } finally {
            clearTimeout(deadline);
        }
        const cert = await readFile(path.join(directory, "cert.pem"));
        const key = await readFile(path.join(directory, "key.pem"));
        const id = crypto.randomUUID();
        const credential = issueComputerCredential("device", id).token;
        let requests = 0;
        let mode: "valid" | "redirect" | "stalled" = "valid";
        server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            tls: { cert, key },
            fetch(request) {
                requests++;
                expect(request.headers.get("authorization")).toBe(`Bearer ${credential}`);
                if (mode === "redirect")
                    return Response.redirect(
                        new URL("/unexpected", request.url).href,
                        307
                    );
                if (mode === "stalled")
                    return new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue(new TextEncoder().encode("{"));
                            },
                        }),
                        { headers: { "content-type": "application/json" } }
                    );
                return Response.json({
                    connectionId: crypto.randomUUID(),
                    heartbeatSeconds: 15,
                    leaseSeconds: 45,
                    controlAllowed: false,
                });
            },
        });
        const origin = `https://127.0.0.1:${server.port}`;
        await rejects(
            new ComputerCompanion(origin).connect(credential, signal()),
            ComputerConnectionError
        );
        expect(requests).toBe(0);
        const client = new ComputerCompanion(origin, (url, init) =>
            fetch(url, {
                ...init,
                tls: { ca: cert, rejectUnauthorized: true },
                proxy: false,
            })
        );
        expect(await client.connect(credential, signal())).toMatchObject({
            controlAllowed: false,
        });
        expect(requests).toBe(1);
        mode = "redirect";
        await rejects(client.connect(credential, signal()), ComputerConnectionError);
        expect(requests).toBe(2);
        mode = "stalled";
        const stopped = new AbortController();
        const timer = setTimeout(() => stopped.abort(), 50);
        try {
            await rejects(
                client.connect(credential, stopped.signal),
                ComputerConnectionError
            );
        } finally {
            clearTimeout(timer);
        }
    } finally {
        await server?.stop(true);
        await rm(directory, { recursive: true, force: true });
    }
}, 15_000);
