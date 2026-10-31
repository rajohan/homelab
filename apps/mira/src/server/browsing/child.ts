import type { Readable, Writable } from "node:stream";

import * as v from "valibot";

import { BrowserDownloadTransfer } from "./downloadTransfer";
import { browserDriverVersion } from "./driver";
import { openNativeBrowser } from "./native";
import { browserUrl } from "./policy";
import { BrowserProfileTransfer, browserProfileParts } from "./profileTransfer";
import { BrowserUploadTransfer } from "./uploadTransfer";

/** Fixed tmpfs callbacks available only to the host-marked saved-profile worker. */
export interface BrowserWorkerProfile {
    restore: (snapshot: string | null) => Promise<void>;
    capture: () => Promise<string>;
}
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
 * @param profile - Private fixed-root snapshot callbacks; omitted for temporary workers.
 * @returns Completion after native cleanup; cleanup failure rejects and forced exit is never success.
 */
export function serveBrowserWorker(
    input: Readable,
    output: Writable,
    open: typeof openNativeBrowser = openNativeBrowser,
    forceExit: () => void = () => {
        process.kill(process.pid, "SIGKILL");
    },
    profile?: BrowserWorkerProfile
): Promise<void> {
    const owner = new AbortController();
    const done = Promise.withResolvers<void>();
    let buffer = Buffer.alloc(0);
    let active = Promise.resolve();
    let busy = false,
        stopped = false,
        initialized = false,
        lastId = 0;
    let initializationFailed = false;
    const restore = new BrowserProfileTransfer();
    const upload = new BrowserUploadTransfer();
    const download = new BrowserDownloadTransfer();
    let restored = false;
    let port: Awaited<ReturnType<typeof open>> | undefined;
    let grant: ReturnType<typeof browserWorkerGrant> | undefined;
    const lifetime = setTimeout(() => stop(), 300_000);
    let idle = setTimeout(() => stop(), 60_000);
    const stop = () => {
        if (stopped) return;
        stopped = true;
        owner.abort();
        upload.clear();
        download.clear();
        buffer = Buffer.alloc(0);
        clearTimeout(lifetime);
        clearTimeout(idle);
        input.off("data", receive);
        input.destroy();
        if (!profile) output.destroy();
        const forced = setTimeout(forceExit, profile ? 4000 : 2000);
        void active
            .catch(() => {})
            .then(async () => {
                try {
                    await port?.close();
                    if (initializationFailed)
                        throw new Error("Initialization did not confirm cleanup.");
                    if (profile && restored && port) {
                        const snapshot = await profile.capture();
                        for (const part of browserProfileParts(snapshot)) {
                            const message = JSON.stringify({ checkpoint: part }) + "\n";
                            await new Promise<void>((resolve, reject) =>
                                output.write(message, (error) =>
                                    error ? reject(error) : resolve()
                                )
                            );
                        }
                    }
                    done.resolve();
                    return true;
                } catch {
                    done.reject(new Error("Browser worker cleanup did not complete."));
                    return false;
                } finally {
                    output.destroy();
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
        if (
            upload.active &&
            command.method !== "uploadPart" &&
            command.method !== "uploadFinish"
        )
            throw new Error("Browser upload transfer is incomplete.");
        if (
            download.active &&
            command.method !== "downloadPart" &&
            command.method !== "downloadFinish"
        )
            throw new Error("Browser download transfer is incomplete.");
        let result: unknown;
        if (command.method === "profile") {
            if (!profile || initialized || restored)
                throw new Error("Unexpected browser profile restore.");
            const snapshot = restore.accept(command.params);
            if (snapshot !== undefined) {
                await profile.restore(snapshot);
                restored = true;
            }
            result = { accepted: true };
        } else if (command.method === "initialize") {
            if (profile && !restored)
                throw new Error("Browser profile restore is incomplete.");
            if (initialized) throw new Error("Browser worker already initialized.");
            initialized = true;
            grant = browserWorkerGrant(command.params);
            try {
                port = await open(
                    { ...grant, executable: browserWorkerExecutable },
                    owner.signal
                );
            } catch (error) {
                // No port exists to retry/confirm cleanup. Even a startup cancellation
                // must not turn an unknown native cleanup outcome into worker success.
                initializationFailed = true;
                throw error;
            }
            result = { version: 1, driver: browserDriverVersion };
        } else {
            if (!port || !grant) throw new Error("Browser worker is not initialized.");
            owner.signal.throwIfAborted();
            switch (command.method) {
                case "downloadBegin": {
                    if (!grant.downloads)
                        throw new Error("Browser downloads are unavailable.");
                    const file = await port.download(command.params, owner.signal);
                    owner.signal.throwIfAborted();
                    result = download.begin(file);
                    break;
                }
                case "downloadPart": {
                    result = download.take(command.params);
                    break;
                }
                case "downloadFinish": {
                    download.finish();
                    result = { accepted: true };
                    break;
                }
                case "uploadBegin": {
                    if (!grant.uploads)
                        throw new Error("Browser uploads are unavailable.");
                    upload.begin(command.params);
                    result = { accepted: true };
                    break;
                }
                case "uploadPart": {
                    upload.accept(command.params);
                    result = { accepted: true };
                    break;
                }
                case "uploadFinish": {
                    const selected = upload.finish();
                    result = await port.upload(
                        selected.input,
                        selected.file,
                        owner.signal
                    );
                    break;
                }
                case "observe": {
                    const frame = browserWorkerFrame(
                        await port.observe(
                            owner.signal,
                            command.params.operator ?? false
                        ),
                        grant.origins
                    );
                    result = command.params.operator
                        ? frame
                        : {
                              ...frame,
                              refs: frame.refs
                                  .map((item) => ({
                                      ...item,
                                      actions: item.actions.filter(
                                          (action) => action !== "upload"
                                      ),
                                  }))
                                  .filter((item) => item.actions.length),
                          };
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
