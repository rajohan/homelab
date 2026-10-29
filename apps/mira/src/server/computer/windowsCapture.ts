import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { imageSize } from "image-size";

import { computerEnvironment } from "../config/environment";
import { computerWindowGrant } from "./policy";

export interface WindowsCaptureImage {
    dataBase64: string;
    width: number;
    height: number;
}
export interface WindowsCapturePort {
    /** Read one bounded frame of the fixed local target; cancellation discards all pixels. */
    read: (signal: AbortSignal) => Promise<WindowsCaptureImage>;
    /** Abort and reap any pending helper before releasing this port. */
    close: () => Promise<void>;
}
// Reserve space for Base64 and nested JSON escaping of the bounded tree in the 3 MiB machine API.
export const windowsCaptureMaximumPngBytes = 1792 * 1024;

type CaptureRunner = (args: string[], signal: AbortSignal) => Promise<Buffer>;

/**
 * Bind the packaged window-only capture helper to a locally approved process creation identity.
 * @param input - Immutable local grant; Windows process creation time is mandatory.
 * @param runner - Synthetic process substitute for tests; production always uses the fixed sibling.
 * @returns A single-operation port whose close waits for its owned helper to exit.
 */
export async function openWindowsCapture(
    input: unknown,
    runner?: CaptureRunner
): Promise<WindowsCapturePort> {
    const grant = computerWindowGrant(input);
    if (!grant.startedAt)
        throw new Error("Window capture requires the local process creation identity.");
    const run = runner ?? (await packagedRunner());
    const args = [String(grant.pid), grant.windowId, grant.startedAt];
    const stopped = new AbortController();
    let active: Promise<Buffer> | undefined;
    return {
        read: async (signal) => {
            const combined = AbortSignal.any([signal, stopped.signal]);
            combined.throwIfAborted();
            if (active) throw new Error("Window capture is already active.");
            const operation = Promise.resolve().then(() => {
                combined.throwIfAborted();
                return run([...args], combined);
            });
            active = operation;
            try {
                const bytes = await operation;
                combined.throwIfAborted();
                if (
                    !Buffer.isBuffer(bytes) ||
                    bytes.length > windowsCaptureMaximumPngBytes ||
                    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
                    bytes.subarray(-8).toString("hex") !== "49454e44ae426082"
                )
                    throw new Error("Invalid window capture image.");
                const { width, height } = imageSize(bytes);
                if (
                    width < 1 ||
                    height < 1 ||
                    width > 8192 ||
                    height > 8192 ||
                    width * height > 8 * 1024 * 1024
                )
                    throw new Error("Window capture exceeds its frame budget.");
                return { dataBase64: bytes.toString("base64"), width, height };
            } catch {
                throw new Error("Window-only capture is unavailable.");
            } finally {
                active = undefined;
            }
        },
        close: async () => {
            stopped.abort();
            await active?.catch(() => {});
        },
    };
}

async function packagedRunner(): Promise<CaptureRunner> {
    if (process.platform !== "win32" || process.arch !== "x64")
        throw new Error("Window-only capture requires Windows x64.");
    const file = path.join(path.dirname(process.execPath), "mira-window-capture.exe");
    const metadata = await lstat(file);
    const canonical = await realpath(file);
    if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        canonical.toLowerCase() !== file.toLowerCase()
    )
        throw new Error("Window capture requires its ordinary packaged executable.");
    return createCaptureRunner({
        command: file,
        cwd: path.dirname(file),
        environment: computerEnvironment(),
    });
}

/**
 * Execute a fixed host-owned helper with bounded private pipes and cancellation.
 * @param options - Trusted launch paths/environment; prefix arguments exist only for synthetic fixtures.
 * @returns A runner that resolves only after clean child exit, without exposing diagnostics.
 */
export function createCaptureRunner(options: {
    command: string;
    cwd: string;
    environment: Record<string, string>;
    prefix?: string[];
}): CaptureRunner {
    if (!path.isAbsolute(options.command) || !path.isAbsolute(options.cwd))
        throw new Error("Capture helper paths must be absolute.");
    const command = options.command,
        cwd = options.cwd;
    const environment = { ...options.environment },
        prefix = [...(options.prefix ?? [])];
    return (args, signal) =>
        new Promise((resolve, reject) => {
            execFile(
                command,
                [...prefix, ...args],
                {
                    cwd,
                    env: environment,
                    windowsHide: true,
                    encoding: "buffer",
                    timeout: 4500,
                    maxBuffer: windowsCaptureMaximumPngBytes,
                    killSignal: "SIGKILL",
                    signal,
                },
                (error, stdout) => {
                    // Never attach native output or process arguments to an exported error.
                    if (error)
                        reject(
                            new Error("Window capture helper did not finish cleanly.")
                        );
                    else resolve(stdout);
                }
            );
        });
}
