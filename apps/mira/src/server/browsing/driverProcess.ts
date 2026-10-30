import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { browserDriverEnvironment } from "../config/environment";
import { RpcProcess } from "../runtime/rpcProcess";

export interface BrowserDriverHost {
    signal: AbortSignal;
    ready: (signal: AbortSignal) => Promise<void>;
    connect: () => Pick<RpcProcess, "request" | "notify" | "close" | "signal">;
    stop: () => Promise<void>;
}

/**
 * Launch the official daemon with its bounded manifest and no listening network port.
 * @param manifest - Canonical host-written capability file.
 * @param directory - Private session directory for the Unix socket and PID file.
 * @param binary - Fixed packaged CLI; synthetic executable replacement is for offline unit tests only.
 * @returns Owned process controls; the outer browser container remains the process-tree supervisor.
 */
export async function launchBrowserDriver(
    manifest: string,
    directory: string,
    binary = "/opt/mira-browser/cua-driver"
): Promise<BrowserDriverHost> {
    if (
        process.platform !== "linux" ||
        process.arch !== "x64" ||
        (await realpath(directory)) !== directory ||
        manifest !== path.join(directory, "capabilities.json")
    )
        throw new Error(
            "The browser driver requires its private Linux session directory."
        );
    const metadata = await lstat(binary);
    if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new Error("The packaged browser driver is missing.");
    const socket = path.join(directory, "driver.sock");
    const environment = browserDriverEnvironment();
    const stopped = new AbortController();
    const daemon = spawn(
        binary,
        [
            "serve",
            "--socket",
            socket,
            "--pid-file",
            path.join(directory, "driver.pid"),
            "--permission-mode",
            "bounded",
            "--capability-manifest",
            manifest,
            "--approve-capability-manifest",
            "--no-overlay",
        ],
        { cwd: directory, env: environment, stdio: "ignore", windowsHide: true }
    );
    let exited = false;
    let closing: Promise<void> | undefined;
    const exit = new Promise<void>((resolve) => {
        daemon.once("close", () => {
            exited = true;
            stopped.abort();
            resolve();
        });
    });
    daemon.on("error", () => stopped.abort());
    return {
        signal: stopped.signal,
        ready: async (signal) => {
            const deadline = performance.now() + 5000;
            while (true) {
                signal.throwIfAborted();
                stopped.signal.throwIfAborted();
                const metadata = await lstat(socket).catch(() => null);
                if (metadata?.isSocket()) return;
                if (performance.now() >= deadline)
                    throw new Error("Browser driver startup timed out.");
                await Bun.sleep(25);
            }
        },
        connect: () => {
            stopped.signal.throwIfAborted();
            return new RpcProcess({
                command: binary,
                args: ["mcp", "--socket", socket],
                cwd: directory,
                env: environment,
                jsonrpc: true,
                requestTimeoutMs: 10_000,
                maxFrameBytes: 16 * 1024 * 1024,
                onRequest: () =>
                    Promise.reject(new Error("Browser callbacks are not allowed.")),
            });
        },
        stop: () => {
            closing ??= (async () => {
                await Promise.resolve();
                stopped.abort();
                if (!exited) daemon.kill();
                const force = setTimeout(() => {
                    if (!exited) daemon.kill("SIGKILL");
                }, 2000);
                try {
                    await exit;
                } finally {
                    clearTimeout(force);
                }
                return;
            })();
            return closing;
        },
    };
}
