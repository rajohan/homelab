import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { imageSize } from "image-size";
import * as v from "valibot";

import { RpcProcess, type RpcProcessOptions } from "../runtime/rpcProcess";
import { runtimeContentItems, type RuntimeToolResult } from "../runtime/toolResult";
import { computerDriverVersion, computerWindowGrant } from "./policy";
import type { ComputerWindowPort } from "./session";

export interface ComputerProcessOptions {
    entrypoint: string;
    cwd: string;
    environment: Record<string, string>;
    signal: AbortSignal;
    requestTimeoutMs?: number;
}
const actionResult = v.strictObject({
    effect: v.picklist(["confirmed", "partial", "unverified", "refused", "unknown"]),
});
const dimension = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8192));
const frameSchema = v.pipe(
    v.strictObject({
        snapshot: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
        width: dimension,
        height: dimension,
        content: v.custom<Exclude<RuntimeToolResult, string>>((value) => {
            if (typeof value === "string") return false;
            try {
                return (
                    runtimeContentItems(value).filter(
                        (item) => item.type === "inputImage"
                    ).length === 1
                );
            } catch {
                return false;
            }
        }),
    }),
    v.check((frame) => {
        const image = frame.content.content.find((item) => item.type === "image");
        if (!image) return false;
        const actual = imageSize(Buffer.from(image.data, "base64"));
        return actual.width === frame.width && actual.height === frame.height;
    })
);

/**
 * Select only OS/session variables needed by the native child, never provider credentials or runtime flags.
 * @param source - Trusted host environment; display access still carries the user's desktop authority.
 * @returns An explicit environment without dotenv loading, preload hooks, database or API tokens.
 */
export function computerChildEnvironment(
    source: Record<string, string | undefined>
): Record<string, string> {
    const selected: Record<string, string> = {};
    for (const key of [
        "PATH",
        "Path",
        "HOME",
        "USERPROFILE",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "DISPLAY",
        "XAUTHORITY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
    ]) {
        const value = source[key];
        if (value !== undefined) selected[key] = value;
    }
    return selected;
}

/**
 * Start one native window driver behind a private, bounded child connection.
 * @param grantInput - Canonical host-selected window grant, never model parameters.
 * @param options - Trusted packaged entrypoint, working directory and host cancellation.
 * @returns A port for ComputerWindowSession; closing it waits for the child to exit.
 */
export async function openComputerProcess(
    grantInput: unknown,
    options: ComputerProcessOptions
): Promise<ComputerWindowPort> {
    if (!path.isAbsolute(options.entrypoint) || !path.isAbsolute(options.cwd))
        throw new Error("Computer worker paths must be absolute.");
    return openWorker(grantInput, options, {
        command: process.execPath,
        args: ["--no-env-file", options.entrypoint],
    });
}

/**
 * Open the fixed packaged Windows supervisor, requiring confirmed process-tree cleanup on close.
 * @param grantInput - Immutable local consent target; no executable path comes from the remote command.
 * @param options - Trusted installed package directory, filtered environment and permanent stop signal.
 * @returns A private worker port; unconfirmed cleanup rejects and must block replacement.
 */
export async function openWindowsComputerProcess(
    grantInput: unknown,
    options: Omit<ComputerProcessOptions, "entrypoint" | "cwd"> & { directory: string }
): Promise<ComputerWindowPort> {
    if (process.platform !== "win32" || process.arch !== "x64")
        throw new Error("The packaged computer worker requires Windows x64.");
    const canonical = path.isAbsolute(options.directory)
        ? await realpath(options.directory)
        : null;
    if (!canonical || canonical.toLowerCase() !== options.directory.toLowerCase())
        throw new Error("The worker package directory must be canonical and absolute.");
    for (const name of ["mira-computer-worker-host.exe", "mira-computer-worker.exe"]) {
        const file = path.join(options.directory, name);
        const metadata = await lstat(file);
        if (!metadata.isFile() || metadata.isSymbolicLink())
            throw new Error(
                "The worker package must contain ordinary local executables."
            );
    }
    return openWorker(
        grantInput,
        { ...options, cwd: options.directory },
        {
            command: path.join(options.directory, "mira-computer-worker-host.exe"),
            args: [],
            stopViaStdin: true,
            requireCleanExit: true,
        }
    );
}

async function openWorker(
    grantInput: unknown,
    options: Omit<ComputerProcessOptions, "entrypoint">,
    launch: Pick<
        RpcProcessOptions,
        "command" | "args" | "stopViaStdin" | "requireCleanExit"
    >
): Promise<ComputerWindowPort> {
    const grant = computerWindowGrant(grantInput);
    const timeout = options.requestTimeoutMs ?? 10_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10_000)
        throw new Error(
            "Computer request deadline must be between one and ten thousand milliseconds."
        );
    options.signal.throwIfAborted();
    const temporary = await mkdtemp(path.join(tmpdir(), "mira-computer-worker-"));
    const processAbort = new AbortController();
    let connection: RpcProcess;
    try {
        connection = new RpcProcess({
            ...launch,
            cwd: options.cwd,
            env: {
                ...computerChildEnvironment(options.environment),
                TMPDIR: temporary,
                TMP: temporary,
                TEMP: temporary,
            },
            signal: processAbort.signal,
            requestTimeoutMs: timeout,
            maxFrameBytes: 4 * 1024 * 1024,
            onRequest: () => {
                processAbort.abort();
                return Promise.reject(
                    new Error("Computer workers cannot request host tools.")
                );
            },
        });
    } catch {
        await rm(temporary, { recursive: true, force: true });
        throw new Error("Computer worker could not start.");
    }
    connection.subscribe(() => {
        processAbort.abort();
    });
    const cancelHost = () => {
        processAbort.abort();
    };
    options.signal.addEventListener("abort", cancelHost, { once: true });
    if (options.signal.aborted) cancelHost();
    const lifetime = setTimeout(() => processAbort.abort(), 300_000);
    let idle = setTimeout(() => processAbort.abort(), 60_000);
    let busy = false;
    let closePromise: Promise<void> | undefined;
    const close = () => {
        clearTimeout(lifetime);
        clearTimeout(idle);
        processAbort.abort();
        options.signal.removeEventListener("abort", cancelHost);
        closePromise ??= connection
            .close()
            .then(() => rm(temporary, { recursive: true, force: true }));
        return closePromise;
    };
    const ended = () => {
        void close().catch(() => {});
    };
    connection.signal.addEventListener("abort", ended, { once: true });
    if (connection.signal.aborted) ended();
    const cancelRequest = () => {
        processAbort.abort();
    };
    const request = async (method: string, params: unknown, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (busy) throw new Error("Computer worker already has an active call.");
        connection.signal.throwIfAborted();
        busy = true;
        clearTimeout(idle);
        signal.addEventListener("abort", cancelRequest, { once: true });
        try {
            if (signal.aborted) cancelHost();
            const result = await connection.request(method, params);
            signal.throwIfAborted();
            connection.signal.throwIfAborted();
            return result;
        } catch {
            await close();
            throw new Error(
                "Computer worker stopped; the operation's outcome is unknown."
            );
        } finally {
            signal.removeEventListener("abort", cancelRequest);
            busy = false;
            if (!connection.signal.aborted)
                idle = setTimeout(() => processAbort.abort(), 60_000);
        }
    };
    try {
        v.parse(
            v.strictObject({
                version: v.literal(1),
                driver: v.literal(computerDriverVersion),
            }),
            await request("initialize", grant, options.signal)
        );
    } catch {
        await close();
        throw new Error("Computer worker could not initialize.");
    }
    const validated = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
            return await operation();
        } catch {
            await close();
            throw new Error(
                "Computer worker returned no valid result; its outcome is unknown."
            );
        }
    };
    return {
        observe: (signal) =>
            validated(async () =>
                v.parse(frameSchema, await request("observe", {}, signal))
            ),
        click: (x, y, signal) =>
            validated(async () =>
                v.parse(actionResult, await request("click", { x, y }, signal))
            ),
        type: (text, signal) =>
            validated(async () =>
                v.parse(actionResult, await request("type", { text }, signal))
            ),
        close,
    };
}
