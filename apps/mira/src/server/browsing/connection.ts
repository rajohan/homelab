import type { Duplex } from "node:stream";

import * as v from "valibot";

import { attachBrowserContainer, browserDockerFrames } from "./attach";
import { prepareBrowserContainer } from "./container";

const configuration = v.strictObject({
    socketPath: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    imageId: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/)),
});
const replySchema = v.strictObject({
    id: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(Number.MAX_SAFE_INTEGER)
    ),
    result: v.unknown(),
});
type Lease = Awaited<ReturnType<typeof prepareBrowserContainer>>;
interface Pending {
    id: number;
    resolve: (result: unknown) => void;
    reject: (error: unknown) => void;
    cancel: () => void;
    timer: ReturnType<typeof setTimeout>;
}
interface Dependencies {
    prepare?: typeof prepareBrowserContainer;
    attach?: typeof attachBrowserContainer;
    requestTimeoutMs?: number;
}

/** A single-flight JSONL channel whose retirement includes confirmed process-tree cleanup. */
class BrowserConnection {
    private readonly stream: Duplex;
    private readonly lease: Lease;
    private readonly owner: AbortSignal;
    private readonly timeoutMs: number;
    private readonly controller = new AbortController();
    private readonly lifetime: ReturnType<typeof setTimeout>;
    private idle: ReturnType<typeof setTimeout>;
    private closing: Promise<void> | undefined;
    private failure: Error | undefined;
    private pending: Pending | undefined;
    private buffer = Buffer.alloc(0);
    private nextId = 1;
    private readonly disconnected = () => this.retire();

    /**
     * Bind one private stream to its owning lease; no remote endpoint or arbitrary process can be attached.
     * @param stream - Docker's private upgraded stdin/stdout stream, attached before container start.
     * @param lease - The exact immutable container lifetime that must be removed on failure.
     * @param owner - Permanent host cancellation.
     * @param timeoutMs - Validated request deadline from the host factory.
     */
    constructor(stream: Duplex, lease: Lease, owner: AbortSignal, timeoutMs: number) {
        this.stream = stream;
        this.lease = lease;
        this.owner = owner;
        this.timeoutMs = timeoutMs;
        const decode = browserDockerFrames((bytes, complete) =>
            this.receive(bytes, complete)
        );
        stream.on("data", (chunk: Buffer) => {
            if (this.failure) return;
            try {
                decode(chunk);
            } catch {
                this.retire();
            }
        });
        stream.on("error", this.disconnected);
        stream.on("end", this.disconnected);
        stream.on("close", this.disconnected);
        this.lifetime = setTimeout(this.disconnected, 300_000);
        this.idle = setTimeout(this.disconnected, 60_000);
        this.lifetime.unref();
        this.idle.unref();
        owner.addEventListener("abort", this.disconnected, { once: true });
        lease.signal.addEventListener("abort", this.disconnected, { once: true });
        if (owner.aborted || lease.signal.aborted) this.retire();
    }

    /**
     * Read permanent cancellation, raised before cleanup starts.
     * @returns The permanently revoked lifetime signal.
     */
    get signal(): AbortSignal {
        return this.controller.signal;
    }

    /**
     * Send one bounded host-owned request. This transport never retries, reconnects or dispatches tools.
     * @param body - Private worker payload, validated by the operation-specific caller and worker.
     * @param operation - Cancellation of this operation retires the entire lifetime.
     * @returns An untrusted reply only for this request ID; the caller must validate its result schema.
     */
    request(body: unknown, operation: AbortSignal): Promise<unknown> {
        if (this.failure)
            return this.closing!.then(() => {
                throw this.failure!;
            });
        if (this.pending)
            return Promise.reject(new Error("The browser connection is busy."));
        operation.throwIfAborted();
        const id = this.nextId++;
        const line = JSON.stringify({ id, body }) + "\n";
        if (Buffer.byteLength(line) > 64 * 1024 || this.stream.writableLength > 64 * 1024)
            throw new Error("The browser request exceeds its limit.");
        clearTimeout(this.idle);
        return new Promise((resolve, reject) => {
            const onAbort = () => this.retire();
            const cancel = () => operation.removeEventListener("abort", onAbort);
            const timer = setTimeout(this.disconnected, this.timeoutMs);
            this.pending = { id, resolve, reject, cancel, timer };
            operation.addEventListener("abort", onAbort, { once: true });
            if (operation.aborted) this.retire();
            else {
                try {
                    this.stream.write(line, (error) => {
                        if (error) this.retire();
                    });
                } catch {
                    this.retire();
                }
            }
        });
    }

    /** Revoke immediately, destroy the stream and wait for confirmed removal of every container process. */
    async close(): Promise<void> {
        this.retire();
        await this.closing;
    }

    private receive(bytes: Buffer, frameComplete: boolean) {
        if (this.failure) return;
        if (!this.pending || this.buffer.length + bytes.length > 4 * 1024 * 1024)
            throw new Error("Unexpected or oversized browser reply.");
        this.buffer = Buffer.concat([this.buffer, bytes]);
        const end = this.buffer.indexOf(10);
        if (end === -1) return;
        if (!frameComplete || end !== this.buffer.length - 1)
            throw new Error("Unexpected browser reply framing.");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
            this.buffer.subarray(0, end)
        );
        const reply = v.parse(replySchema, JSON.parse(text));
        const pending = this.pending;
        if (reply.id !== pending.id) throw new Error("Unexpected browser reply ID.");
        this.buffer = Buffer.alloc(0);
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.cancel();
        this.idle = setTimeout(this.disconnected, 60_000);
        this.idle.unref();
        pending.resolve(reply.result);
    }

    private retire() {
        if (this.failure) return;
        this.failure = new Error(
            "Browser connection stopped; the last operation may have completed. Do not replay input."
        );
        this.closing = Promise.resolve().then(() => this.lease.close());
        this.controller.abort();
        clearTimeout(this.lifetime);
        clearTimeout(this.idle);
        this.owner.removeEventListener("abort", this.disconnected);
        this.lease.signal.removeEventListener("abort", this.disconnected);
        this.buffer = Buffer.alloc(0);
        this.stream.destroy();
        const pending = this.pending;
        this.pending = undefined;
        if (pending) {
            clearTimeout(pending.timer);
            pending.cancel();
        }
        void this.closing.then(
            () => pending?.reject(this.failure),
            (error: unknown) => pending?.reject(error)
        );
    }
}

/**
 * Create, attach and then start a container using only a trusted local Engine socket and image ID.
 * @param input - Host-owned configuration; no ports, mounts, commands or network flags are accepted.
 * @param signal - Permanent owner cancellation throughout creation, attachment, startup and requests.
 * @param dependencies - Synthetic factories and a shortened deadline for qualification only.
 * @returns One private transport. Close must succeed before a replacement lifetime is permitted.
 */
export async function openBrowserConnection(
    input: unknown,
    signal: AbortSignal,
    dependencies: Dependencies = {}
) {
    signal.throwIfAborted();
    const config = v.parse(configuration, input);
    const timeout = dependencies.requestTimeoutMs ?? 30_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
        throw new Error("Invalid browser request deadline.");
    const lease = await (dependencies.prepare ?? prepareBrowserContainer)(config, signal);
    let stream: Duplex | undefined;
    let connection: BrowserConnection | undefined;
    try {
        stream = await (dependencies.attach ?? attachBrowserContainer)(
            config.socketPath,
            lease.id,
            AbortSignal.any([signal, lease.signal])
        );
        connection = new BrowserConnection(stream, lease, signal, timeout);
        connection.signal.throwIfAborted();
        await lease.start();
        connection.signal.throwIfAborted();
        return connection;
    } catch (error) {
        stream?.destroy();
        await (connection ? connection.close() : lease.close());
        throw error;
    }
}
