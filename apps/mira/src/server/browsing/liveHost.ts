import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import path from "node:path";

import {
    type browserClipboardCommandSchema,
    browserClipboardResultSchema,
    browserClipboardTimeoutMs,
} from "@homelab/contracts/miraBrowserClipboard";
import type { SQL } from "bun";
import * as v from "valibot";

import { readMiraBrowserLive } from "../data/browserLive";
import {
    type browserLiveIdentitySchema,
    browserLiveRequestSchema,
    browserLiveSocket,
} from "./liveSocket";
import { BrowserDisplayUnavailable, openBrowserVnc } from "./vnc";

type Identity = v.InferOutput<typeof browserLiveIdentitySchema>;
type Entry = {
    owner: string;
    processId: string;
    containerId: string;
    signal: AbortSignal;
    clipboard: (
        input: unknown,
        signal: AbortSignal
    ) => Promise<v.InferOutput<typeof browserClipboardResultSchema>>;
};
type Viewer = {
    identity: Identity;
    control: boolean;
    socket: Socket;
    abort: AbortController;
    clipboard?: Promise<void>;
    stop: () => Promise<void>;
};

/** Serve authenticated dashboard display connections over private shared-directory IPC.
 * @param options - Host configuration and database; the renderer has no network listener.
 * @returns Registration, handover synchronization and complete listener cleanup.
 */
export async function serveBrowserLive(options: {
    client: SQL;
    directory: string;
    hostId: string;
    socketPath: string;
    signal: AbortSignal;
}) {
    const socketPath = browserLiveSocket(options.directory, options.hostId);
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    const existing = await lstat(socketPath).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return null;
        throw error;
    });
    if (existing) {
        if (!existing.isSocket()) throw new Error("Invalid browser display socket.");
        const active = await new Promise<boolean>((resolve) => {
            const probe = connect(socketPath);
            probe.once("connect", () => {
                probe.destroy();
                resolve(true);
            });
            probe.once("error", () => {
                probe.destroy();
                resolve(false);
            });
        });
        if (active) throw new Error("Browser display host is already running.");
        await unlink(socketPath);
    }
    const entries = new Map<string, Entry>();
    const views = new Map<string, Viewer>();
    const controls = new Map<string, Viewer>();
    const invalidated = new Set<string>();
    const clipboard = new Map<
        string,
        {
            identity: Identity;
            command: v.InferOutput<typeof browserClipboardCommandSchema>;
            signal: AbortSignal;
            socket: Socket;
        }
    >();
    const sockets = new Set<Socket>();
    const context = (owner: string) => ({
        client: options.client,
        owner,
        actor: `human:${owner}`,
    });
    const authority = async (identity: Identity) => {
        const row = await readMiraBrowserLive(context(identity.owner), identity);
        const entry = entries.get(identity.accessId);
        if (
            !entry ||
            entry.signal.aborted ||
            row.hostId !== options.hostId ||
            entry.owner !== identity.owner ||
            entry.processId !== row.processId ||
            entry.containerId !== row.containerId
        )
            throw new Error("Browser display is unavailable.");
        return { row, entry };
    };
    const accept = async (socket: Socket, identity: Identity) => {
        const { row, entry } = await authority(identity);
        const viewers = identity.epoch === null ? views : controls;
        const previous = viewers.get(identity.accessId);
        if (previous) {
            if (previous.identity.epoch === identity.epoch && !previous.socket.destroyed)
                throw new Error("Browser display is already connected.");
            await previous.stop();
            if (viewers.get(identity.accessId) === previous)
                viewers.delete(identity.accessId);
        }
        if (viewers.has(identity.accessId) || socket.destroyed)
            throw new Error("Browser display changed.");
        const abort = new AbortController();
        let display: Awaited<ReturnType<typeof openBrowserVnc>> | undefined;
        let opening: Promise<Awaited<ReturnType<typeof openBrowserVnc>>> | undefined;
        let stopping: Promise<void> | undefined;
        const viewer: Viewer = {
            identity,
            control: row.control,
            socket,
            abort,
            stop: () =>
                (stopping ??= Promise.resolve().then(async () => {
                    abort.abort();
                    socket.destroy();
                    try {
                        display ??= await opening;
                    } catch (error) {
                        if (!(error instanceof BrowserDisplayUnavailable)) throw error;
                    }
                    await display?.close();
                    await viewer.clipboard;
                    if (row.control) invalidated.add(identity.accessId);
                    return;
                })),
        };
        viewers.set(identity.accessId, viewer);
        const stop = () => {
            void viewer.stop().catch(() => {});
        };
        socket.once("close", stop);
        const signal = AbortSignal.any([options.signal, entry.signal, abort.signal]);
        signal.addEventListener("abort", stop, { once: true });
        try {
            opening = openBrowserVnc(
                options.socketPath,
                entry.containerId,
                row.control ? (identity.inputOnly ? "input" : "control") : "view",
                signal
            );
            display = await opening;
            signal.throwIfAborted();
            const current = await authority(identity);
            if (current.row.control !== row.control)
                throw new Error("Browser control changed.");
            display.stream.on("error", stop);
            display.stream.on("close", stop);
            socket.pipe(display.stream).pipe(socket);
            socket.resume();
        } catch {
            await viewer.stop();
        }
    };
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => socket.destroy());
        socket.once("close", () => sockets.delete(socket));
        let buffer = Buffer.alloc(0);
        const timer = setTimeout(() => socket.destroy(), 30_000);
        socket.once("close", () => clearTimeout(timer));
        const receive = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > 64 * 1024) {
                socket.destroy();
                return;
            }
            const end = buffer.indexOf(10);
            if (end === -1) return;
            socket.pause();
            socket.off("data", receive);
            clearTimeout(timer);
            if (end !== buffer.length - 1) {
                socket.destroy();
                return;
            }
            try {
                const request = v.parse(
                    browserLiveRequestSchema,
                    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer))
                );
                const identity = {
                    owner: request.owner,
                    accessId: request.accessId,
                    epoch: request.epoch,
                    ...(request.inputOnly ? { inputOnly: true as const } : {}),
                };
                if ("clipboard" in request) {
                    const viewer = controls.get(identity.accessId);
                    if (
                        !viewer?.control ||
                        viewer.socket.destroyed ||
                        viewer.identity.owner !== identity.owner ||
                        viewer.identity.epoch !== identity.epoch ||
                        clipboard.has(identity.accessId) ||
                        viewer.clipboard
                    )
                        throw new Error("Clipboard is unavailable.");
                    const disconnected = new AbortController();
                    const signal = AbortSignal.any([
                        disconnected.signal,
                        viewer.abort.signal,
                        options.signal,
                        AbortSignal.timeout(browserClipboardTimeoutMs),
                    ]);
                    const cancel = () => socket.destroy();
                    signal.addEventListener("abort", cancel, { once: true });
                    const pending = {
                        identity,
                        command: request.clipboard,
                        socket,
                        signal,
                    };
                    clipboard.set(identity.accessId, pending);
                    socket.once("close", () => {
                        signal.removeEventListener("abort", cancel);
                        disconnected.abort();
                        if (clipboard.get(identity.accessId) === pending)
                            clipboard.delete(identity.accessId);
                    });
                    socket.resume();
                    socket.once("data", () => socket.destroy());
                } else void accept(socket, identity).catch(() => socket.destroy());
            } catch {
                socket.destroy();
            }
        };
        socket.on("data", receive);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    await chmod(socketPath, 0o600);
    server.on("error", () => {
        for (const socket of sockets) socket.destroy();
    });
    const stop = () => {
        for (const socket of sockets) socket.destroy();
    };
    options.signal.addEventListener("abort", stop, { once: true });
    return {
        register: (accessId: string, entry: Entry) => {
            entries.set(accessId, entry);
        },
        synchronize: async (accessId: string) => {
            for (const viewers of [views, controls]) {
                const viewer = viewers.get(accessId);
                if (!viewer) continue;
                let valid = false;
                try {
                    const current = await authority(viewer.identity);
                    valid =
                        current.row.control === viewer.control &&
                        !viewer.socket.destroyed;
                } catch {
                    /* Changed control revokes this exact display connection. */
                }
                if (!valid) {
                    await viewer.stop();
                    if (viewers.get(accessId) === viewer) viewers.delete(accessId);
                }
            }
            const pending = clipboard.get(accessId);
            if (pending) {
                clipboard.delete(accessId);
                const currentViewer = controls.get(accessId);
                const perform = async () => {
                    try {
                        const { row, entry } = await authority(pending.identity);
                        if (
                            !row.control ||
                            !currentViewer?.control ||
                            currentViewer.socket.destroyed ||
                            currentViewer.identity.epoch !== pending.identity.epoch ||
                            pending.socket.destroyed
                        )
                            throw new Error("Clipboard control changed.");
                        const signal = AbortSignal.any([
                            pending.signal,
                            entry.signal,
                            currentViewer.abort.signal,
                        ]);
                        signal.throwIfAborted();
                        const result = await entry.clipboard(pending.command, signal);
                        signal.throwIfAborted();
                        const current = await authority(pending.identity);
                        if (
                            !current.row.control ||
                            currentViewer.socket.destroyed ||
                            pending.socket.destroyed
                        )
                            throw new Error("Clipboard control changed.");
                        pending.socket.end(
                            JSON.stringify(
                                v.parse(browserClipboardResultSchema, result)
                            ) + "\n"
                        );
                    } catch {
                        pending.socket.destroy();
                    }
                };
                const work = perform();
                if (currentViewer) currentViewer.clipboard = work;
                await work;
                if (currentViewer) delete currentViewer.clipboard;
            }
            return invalidated.delete(accessId);
        },
        unregister: async (accessId: string) => {
            entries.delete(accessId);
            clipboard.get(accessId)?.socket.destroy();
            clipboard.delete(accessId);
            for (const viewers of [views, controls]) {
                const viewer = viewers.get(accessId);
                if (!viewer) continue;
                await viewer.stop();
                viewers.delete(accessId);
            }
            invalidated.delete(accessId);
        },
        close: async () => {
            options.signal.removeEventListener("abort", stop);
            stop();
            await Promise.allSettled(
                [...views.values(), ...controls.values()].map((viewer) => viewer.stop())
            );
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await unlink(socketPath).catch(() => {});
        },
    };
}
