import type { Readable, Writable } from "node:stream";

import * as v from "valibot";

import { computerDriverVersion } from "../computer/policy";
import { openNativeBrowser } from "./native";
import { browserUrl } from "./policy";
import {
    browserWorkerExecutable,
    browserWorkerFrame,
    browserWorkerGrant,
    browserWorkerRequestSchema,
} from "./wire";

/**
 * Serve fixed browser operations through private pipes inside the host-owned container.
 * @param input - Single trusted parent's JSONL stream; EOF immediately revokes authority.
 * @param output - Bounded result stream; diagnostics and native tool names are never forwarded.
 * @param open - Native implementation, replaceable only for isolated unit qualification.
 * @param forceExit - Process-only fallback if native work or cleanup ignores cancellation.
 * @returns Completion after native cleanup; cleanup failure rejects and forced exit is never success.
 */
export function serveBrowserWorker(
    input: Readable,
    output: Writable,
    open: typeof openNativeBrowser = openNativeBrowser,
    forceExit: () => void = () => {
        process.kill(process.pid, "SIGKILL");
    }
): Promise<void> {
    const owner = new AbortController();
    const done = Promise.withResolvers<void>();
    let buffer = Buffer.alloc(0);
    let active = Promise.resolve();
    let busy = false,
        stopped = false,
        initialized = false,
        lastId = 0;
    let port: Awaited<ReturnType<typeof open>> | undefined;
    let grant: ReturnType<typeof browserWorkerGrant> | undefined;
    const lifetime = setTimeout(() => stop(), 300_000);
    let idle = setTimeout(() => stop(), 60_000);
    const stop = () => {
        if (stopped) return;
        stopped = true;
        owner.abort();
        buffer = Buffer.alloc(0);
        clearTimeout(lifetime);
        clearTimeout(idle);
        input.off("data", receive);
        input.destroy();
        output.destroy();
        const forced = setTimeout(forceExit, 2000);
        void active
            .catch(() => {})
            .then(async () => {
                try {
                    await port?.close();
                    done.resolve();
                    return true;
                } catch {
                    done.reject(new Error("Browser worker cleanup did not complete."));
                    return false;
                } finally {
                    clearTimeout(forced);
                    input.off("end", stop);
                    input.off("close", stop);
                    input.off("error", stop);
                    output.off("error", stop);
                    output.off("close", stop);
                }
            });
    };
    const handle = async (line: Buffer) => {
        const request = v.parse(
            browserWorkerRequestSchema,
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line))
        );
        if (request.id <= lastId) throw new Error("Repeated browser request.");
        lastId = request.id;
        const command = request.body;
        let result: unknown;
        if (command.method === "initialize") {
            if (initialized) throw new Error("Browser worker already initialized.");
            initialized = true;
            grant = browserWorkerGrant(command.params);
            port = await open(
                { ...grant, executable: browserWorkerExecutable },
                owner.signal
            );
            result = { version: 1, driver: computerDriverVersion };
        } else {
            if (!port || !grant) throw new Error("Browser worker is not initialized.");
            owner.signal.throwIfAborted();
            switch (command.method) {
                case "observe": {
                    result = browserWorkerFrame(
                        await port.observe(owner.signal),
                        grant.origins
                    );
                    break;
                }
                case "navigate": {
                    const destination = browserUrl(command.params.url, grant.origins);
                    const navigation = await port.navigate(destination, owner.signal);
                    result = { url: browserUrl(navigation.url, grant.origins) };
                    break;
                }
                case "act": {
                    if (grant.mode !== "control")
                        throw new Error("Browser access is view-only.");
                    result = v.parse(
                        v.strictObject({ effect: v.literal("unverified") }),
                        await port.act(command.params, owner.signal)
                    );
                    break;
                }
            }
        }
        owner.signal.throwIfAborted();
        const response = JSON.stringify({ id: request.id, result }) + "\n";
        if (
            Buffer.byteLength(response) > 4 * 1024 * 1024 ||
            output.writableLength > 4 * 1024 * 1024
        )
            throw new Error("Browser worker response exceeds its limit.");
        await new Promise<void>((resolve, reject) =>
            output.write(response, (error) => (error ? reject(error) : resolve()))
        );
    };
    const receive = (chunk: Buffer) => {
        if (stopped) return;
        if (busy || buffer.length + chunk.length > 64 * 1024) {
            stop();
            return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf(10);
        if (end === -1) return;
        if (end !== buffer.length - 1) {
            stop();
            return;
        }
        const line = buffer.subarray(0, end);
        buffer = Buffer.alloc(0);
        busy = true;
        clearTimeout(idle);
        active = handle(line).finally(() => {
            busy = false;
            if (!stopped) idle = setTimeout(stop, 60_000);
        });
        void active.catch(stop);
    };
    input.on("data", receive);
    input.once("end", stop);
    input.once("close", stop);
    input.once("error", stop);
    output.once("error", stop);
    output.once("close", stop);
    if (
        input.destroyed ||
        input.readableEnded ||
        output.destroyed ||
        output.writableEnded
    )
        stop();
    return done.promise;
}
