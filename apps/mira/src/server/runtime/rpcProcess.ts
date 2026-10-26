import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import * as v from "valibot";

import { envelopeSchema, type RpcId, type RuntimeEvent } from "./protocol";
import { RuntimeResponseError } from "./responseError";

interface PendingRequest {
    missingThreadMessage: string | null;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** A stopped connection whose supervisor did not prove that every owned process exited. */
export class RuntimeCleanupError extends Error {
    /** Create a content-free cleanup failure that must remain sticky across replacement attempts. */
    constructor() {
        super("Computer process-tree cleanup could not be confirmed.");
    }
}
export interface RpcProcessOptions {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    /** Hide console windows by default; native consent surfaces explicitly opt out. */
    windowsHide?: boolean;
    /** Let a process-tree supervisor confirm cleanup after EOF before the forced-stop deadline. */
    stopViaStdin?: boolean;
    /** Require the supervisor's zero exit status as proof that its complete process tree exited. */
    requireCleanExit?: boolean;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
    maxFrameBytes?: number;
    onRequest: (request: RuntimeEvent, signal: AbortSignal) => Promise<unknown>;
}

/** A bounded private JSONL child connection; never exposes the runtime on a port. */
export class RpcProcess {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly serverRequests = new Set<RpcId>();
    private readonly listeners = new Set<(event: RuntimeEvent) => void>();
    private readonly controller = new AbortController();
    private readonly exited: Promise<void>;
    private readonly options: RpcProcessOptions;
    private buffer = Buffer.alloc(0);
    private nextId = 1;
    private failure: Error | null = null;
    private cleanExit = false;
    private forceStop: ReturnType<typeof setTimeout> | null = null;
    private readonly abort = () =>
        this.fail(new Error("Mira runtime operation was cancelled."));

    /**
     * Start a child using explicit arguments and a caller-owned environment.
     * @param options - Executable, process isolation and request handler settings.
     */
    constructor(options: RpcProcessOptions) {
        this.options = options;
        options.signal?.throwIfAborted();
        this.child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            windowsHide: options.windowsHide ?? true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.exited = new Promise((resolve) => {
            this.child.once("close", (code, signal) => {
                this.cleanExit = code === 0 && signal === null;
                options.signal?.removeEventListener("abort", this.abort);
                this.fail(
                    new Error(
                        "Mira runtime disconnected; reconcile the active turn before retrying."
                    )
                );
                if (this.forceStop) clearTimeout(this.forceStop);
                resolve();
            });
        });
        this.child.on("error", () =>
            this.fail(new Error("Mira runtime could not start."))
        );
        this.child.stdin.on("error", () =>
            this.fail(new Error("Mira runtime input closed."))
        );
        this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
        // Drain stderr without retaining prompts, credentials or provider diagnostics.
        this.child.stderr.resume();
        options.signal?.addEventListener("abort", this.abort, { once: true });
        if (options.signal?.aborted) this.abort();
    }

    /**
     * Observe connection cancellation on EOF, errors or shutdown.
     * @returns The signal shared with pending host tool calls.
     */
    get signal(): AbortSignal {
        return this.controller.signal;
    }

    /**
     * Send a request with a bounded lifetime. Timeout retires the entire connection.
     * @param method - Protocol method owned by the caller.
     * @param params - Method parameters; never included in transport error messages.
     * @returns The untrusted response, to be validated at the runtime boundary.
     */
    request(method: string, params: unknown): Promise<unknown> {
        if (this.failure) return Promise.reject(this.failure);
        if (this.pending.size >= 32)
            return Promise.reject(new Error("Mira runtime is busy."));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.fail(
                    new Error("Mira runtime request timed out; its outcome is unknown.")
                );
            }, this.options.requestTimeoutMs ?? 30_000);
            const threadLookup =
                method === "thread/delete" || method === "thread/resume"
                    ? v.safeParse(v.object({ threadId: v.string() }), params)
                    : null;
            const missingPrefix =
                method === "thread/resume"
                    ? "no rollout found for thread id "
                    : "thread not found: ";
            this.pending.set(id, {
                resolve,
                reject,
                timer,
                missingThreadMessage: threadLookup?.success
                    ? `${missingPrefix}${threadLookup.output.threadId}`
                    : null,
            });
            try {
                this.send({ id, method, params });
            } catch {
                this.fail(new Error("Mira runtime request could not be sent."));
            }
        });
    }

    /**
     * Send a protocol notification without creating an unbounded pending request.
     * @param method - Notification method.
     * @param params - Notification parameters.
     */
    notify(method: string, params: unknown): void {
        this.send({ method, params });
    }

    /**
     * Observe notifications synchronously; callers own any durable event storage.
     * @param listener - Handler whose exceptions retire the connection.
     * @returns A function that removes this subscription.
     */
    subscribe(listener: (event: RuntimeEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Stop accepting work, reject waiters and reap the child with a bounded grace period. */
    async close(): Promise<void> {
        this.fail(new Error("Mira runtime closed."));
        await this.exited;
        if (this.options.requireCleanExit && !this.cleanExit)
            throw new RuntimeCleanupError();
    }

    private send(message: unknown): void {
        if (this.failure) throw this.failure;
        const line = JSON.stringify(message) + "\n";
        if (Buffer.byteLength(line) > (this.options.maxFrameBytes ?? 4 * 1024 * 1024))
            throw new Error("Mira runtime request exceeds the frame limit.");
        // Bound writes too; a child that stops reading must not accumulate requests.
        if (this.child.stdin.writableLength > 4 * 1024 * 1024)
            throw new Error("Mira runtime input is backlogged.");
        this.child.stdin.write(line);
    }

    private receive(chunk: Buffer): void {
        if (this.failure) return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const limit = this.options.maxFrameBytes ?? 4 * 1024 * 1024;
        try {
            let end: number;
            while ((end = this.buffer.indexOf(10)) >= 0) {
                if (end > limit) throw new Error("Frame limit");
                const line = this.buffer.subarray(0, end).toString("utf8");
                this.buffer = this.buffer.subarray(end + 1);
                const message = v.parse(envelopeSchema, JSON.parse(line));
                if ("method" in message) {
                    const event = { method: message.method, params: message.params };
                    if ("id" in message) void this.handleRequest(message.id, event);
                    else for (const listener of this.listeners) listener(event);
                } else if (typeof message.id === "number") {
                    const pending = this.pending.get(message.id);
                    if (!pending) continue;
                    clearTimeout(pending.timer);
                    this.pending.delete(message.id);
                    if ("error" in message)
                        pending.reject(
                            new RuntimeResponseError(
                                message.error.code,
                                message.error.code === -32_600 &&
                                    pending.missingThreadMessage !== null &&
                                    message.error.message === pending.missingThreadMessage
                            )
                        );
                    else pending.resolve(message.result);
                }
            }
            if (this.buffer.length > limit) throw new Error("Frame limit");
        } catch {
            this.fail(new Error("Mira runtime sent an invalid or oversized message."));
        }
    }

    private async handleRequest(id: RpcId, event: RuntimeEvent): Promise<void> {
        if (this.serverRequests.has(id) || this.serverRequests.size >= 32) {
            this.fail(new Error("Mira runtime exceeded its host request limit."));
            return;
        }
        this.serverRequests.add(id);
        try {
            const result = await this.options.onRequest(event, this.signal);
            if (!this.failure) this.send({ id, result });
        } catch {
            if (!this.failure) {
                try {
                    this.send({
                        id,
                        error: {
                            code: -32_601,
                            message: "This operation is not authorized by Mira.",
                        },
                    });
                } catch {
                    this.fail(new Error("Mira runtime response could not be sent."));
                }
            }
        } finally {
            this.serverRequests.delete(id);
        }
    }

    private fail(error: Error): void {
        if (this.failure) return;
        this.failure = error;
        this.controller.abort(error);
        this.buffer = Buffer.alloc(0);
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
        this.listeners.clear();
        this.child.stdin.end();
        if (!this.options.stopViaStdin) this.child.kill();
        this.forceStop = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    }
}
