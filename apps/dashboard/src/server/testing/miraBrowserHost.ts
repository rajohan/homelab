import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { gzipSync } from "node:zlib";

import { capabilities } from "@homelab/contracts/operations";
import { setMiraEnabled } from "@homelab/mira/data/automations";
import { claimMiraRun } from "@homelab/mira/data/queue";

import {
    BrowserProfileTransfer,
    browserProfileParts,
} from "../../../../mira/src/server/browsing/profileTransfer";
import { syntheticRedImage } from "../../../../mira/src/server/testing/image";
import { appRouter } from "../api/router";
import { operationFixture } from "./operations";

/**
 * Create a synthetic owned run and a local Unix Docker fixture with durable journal assertions.
 * @param enabled - Whether the synthetic browser switch starts enabled.
 * @returns Disposable product database, strict daemon fixture and exact cleanup.
 */
export async function browserHostFixture(enabled = true) {
    const f = await operationFixture();
    const caller = (
        owner = "operator",
        verified = owner,
        kind: "human" | "automation" = "human",
        fresh = true
    ) =>
        appRouter.createCaller({
            operations: f,
            principal: { kind, id: owner, capabilities },
            ...(fresh
                ? {
                      verifyHuman: () =>
                          Promise.resolve({ kind, id: verified, capabilities }),
                  }
                : {}),
        }).mira;
    const api = caller();
    const context = { client: f.client, owner: "operator", actor: "human:operator" };
    if (enabled)
        await setMiraEnabled(context, {
            key: "computer:browser",
            version: 1,
            enabled: true,
            reason: null,
            until: null,
        });
    const chat = await api.conversations.create({ title: "Synthetic browser access" });
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Synthetic browser task",
        attachmentIds: [],
    });
    const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
    if (!run) throw new Error("Expected synthetic run.");
    const worker = {
        ...context,
        actor: `mira:${run.id}`,
        run: { id: run.id, leaseToken: run.leaseToken },
    };
    const request = {
        runId: run.id,
        origins: ["https://example.test"],
        initialUrl: "https://example.test/start",
        mode: "control" as const,
    };
    const directory = await mkdtemp(path.join(os.tmpdir(), "browser-host-db-"));
    const socketPath = path.join(directory, "docker.sock");
    const engine = {
        id: "b".repeat(64),
        label: "",
        image: `sha256:${"a".repeat(64)}`,
        exists: false,
        failCreate: false,
        holdInput: false,
        observationText: "",
        paddedImage: false,
        rejectCreate: null as number | null,
        replaceCleanupAfterDelete: false,
        failDelete: false,
        omitCheckpoint: false,
        snapshot: gzipSync(
            JSON.stringify([
                {
                    name: "Default/Cookies",
                    data: Buffer.from("synthetic sign-in").toString("base64"),
                },
            ])
        ).toString("base64"),
        restored: [] as (string | null)[],
        events: [] as string[],
    };
    const streams = new Set<Duplex>();
    const server = createServer((request, response) => {
        void (async () => {
            const route = request.url!.replace(/^\/v1\.45/, "");
            const chunks: Buffer[] = [];
            for await (const chunk of request)
                chunks.push(Buffer.from(chunk as Uint8Array));
            engine.events.push(`${request.method}:${route}`);
            let status: number,
                body: unknown = null;
            if (route.startsWith("/containers/create")) {
                const spec = JSON.parse(Buffer.concat(chunks).toString()) as {
                    Image: string;
                    Labels: Record<string, string>;
                };
                engine.label = spec.Labels["io.homelab.mira.browser-owner"]!;
                engine.image = spec.Image;
                const [row] = await f.client<
                    { phase: string }[]
                >`SELECT phase FROM mira_browser_processes WHERE id=${engine.label}`;
                expect(row?.phase).toBe("creating");
                expect(route).toBe(
                    `/containers/create?name=mira-browser-${engine.label}`
                );
                engine.exists = !engine.failCreate && engine.rejectCreate === null;
                status = engine.rejectCreate ?? (engine.failCreate ? 503 : 201);
                body = { Id: engine.id };
            } else if (route.endsWith("/json")) {
                status = engine.exists ? 200 : 404;
                body = engine.exists
                    ? {
                          Id: engine.id,
                          Image: engine.image,
                          Config: {
                              Labels: { "io.homelab.mira.browser-owner": engine.label },
                          },
                      }
                    : null;
            } else if (route.endsWith("/start")) {
                const [row] = await f.client<
                    { phase: string; containerId: string }[]
                >`SELECT phase,container_id AS "containerId" FROM mira_browser_processes WHERE id=${engine.label}`;
                expect(row).toEqual({ phase: "created", containerId: engine.id });
                status = 204;
            } else if (request.method === "DELETE") {
                const [row] = await f.client<
                    { state: string }[]
                >`SELECT state FROM mira_browser_processes WHERE id=${engine.label}`;
                expect(row?.state).toBe("cleanup");
                status = engine.failDelete ? 503 : 204;
                if (!engine.failDelete) {
                    engine.exists = false;
                    if (engine.replaceCleanupAfterDelete) {
                        await f.client`UPDATE mira_browser_processes SET lease_token=${crypto.randomUUID()},lease_expires_at=clock_timestamp()+interval '15 seconds' WHERE id=${engine.label}`;
                    }
                    for (const stream of streams) stream.destroy();
                }
            } else throw new Error("Unexpected fixture Docker request.");
            response.writeHead(status, { "content-type": "application/json" });
            response.end(status === 204 ? undefined : JSON.stringify(body));
        })().catch(() => {
            response.writeHead(500);
            response.end();
        });
    });
    server.on("upgrade", (_request, stream) => {
        streams.add(stream);
        stream.on("error", () => {});
        stream.on("close", () => streams.delete(stream));
        stream.write(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
        );
        let buffered = "";
        const restore = new BrowserProfileTransfer();
        let prepared = false;
        stream.on("end", () => {
            if (prepared && !engine.omitCheckpoint) {
                for (const part of browserProfileParts(engine.snapshot)) {
                    const body = Buffer.from(JSON.stringify({ checkpoint: part }) + "\n");
                    const header = Buffer.alloc(8);
                    header[0] = 1;
                    header.writeUInt32BE(body.length, 4);
                    stream.write(Buffer.concat([header, body]));
                }
            }
            stream.end();
        });
        stream.on("data", (chunk: Buffer) => {
            buffered += chunk.toString();
            while (buffered.includes("\n")) {
                const end = buffered.indexOf("\n"),
                    line = buffered.slice(0, end);
                buffered = buffered.slice(end + 1);
                const message = JSON.parse(line) as {
                    id: number;
                    body: { method: string; params: { url?: string } };
                };
                engine.events.push(message.body.method);
                if (engine.holdInput && message.body.method === "act") continue;
                let result: unknown;
                if (message.body.method === "profile") {
                    const value = restore.accept(message.body.params);
                    if (value !== undefined) {
                        engine.restored.push(value);
                        prepared = true;
                    }
                    result = { accepted: true };
                } else if (message.body.method === "initialize")
                    result = { version: 1, driver: "0.37.0" };
                else if (message.body.method === "observe")
                    result = {
                        observationId: crypto.randomUUID(),
                        url: "https://example.test/start",
                        title: "Synthetic page",
                        outline: engine.observationText
                            ? engine.observationText.repeat(64 * 1024)
                            : "Untrusted synthetic page",
                        complete: true,
                        refs: engine.observationText
                            ? Array.from({ length: 300 }, (_, index) => ({
                                  ref: `p1:${index + 1}`,
                                  role: engine.observationText.repeat(64),
                                  label: engine.observationText.repeat(256),
                                  actions: ["click", "type"],
                              }))
                            : [
                                  {
                                      ref: "p1:1",
                                      role: "button",
                                      label: "Synthetic action",
                                      actions: ["click", "type"],
                                  },
                              ],
                        width: 64,
                        height: 64,
                        content: {
                            content: [
                                {
                                    type: "image",
                                    mediaType: "image/png",
                                    data: (engine.paddedImage
                                        ? Buffer.concat([
                                              syntheticRedImage(),
                                              Buffer.alloc(
                                                  2 * 1024 * 1024 -
                                                      syntheticRedImage().length
                                              ),
                                          ])
                                        : Buffer.from(syntheticRedImage())
                                    ).toString("base64"),
                                },
                            ],
                        },
                    };
                else if (message.body.method === "act") result = { effect: "unverified" };
                else result = { url: message.body.params.url };
                const bytes = Buffer.from(
                        JSON.stringify({ id: message.id, result }) + "\n"
                    ),
                    header = Buffer.alloc(8);
                header[0] = 1;
                header.writeUInt32BE(bytes.length, 4);
                stream.write(Buffer.concat([header, bytes]));
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const config = {
        hostId: crypto.randomUUID(),
        socketPath,
        imageId: `sha256:${"a".repeat(64)}`,
    };
    return {
        ...f,
        caller,
        api,
        context,
        worker,
        run,
        chat,
        request,
        config,
        engine,
        close: async () => {
            for (const stream of streams) stream.destroy();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            );
            await rm(directory, { recursive: true, force: true });
            await f.close();
        },
    };
}
