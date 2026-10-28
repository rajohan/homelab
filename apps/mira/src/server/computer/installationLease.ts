import path from "node:path";

import * as v from "valibot";

import { RpcProcess, type RpcProcessOptions } from "../runtime/rpcProcess";
import { computerChildEnvironment } from "./process";

/**
 * Hold the packaged CLI's installation lease until all of its connection work is stopped.
 * @param options - Trusted local lease executable, arguments and environment; never model-supplied.
 * @returns A process lifetime whose loss must abort the caller, with awaited local cleanup.
 */
export async function openComputerInstallationLease(
    options: Pick<RpcProcessOptions, "command" | "args" | "cwd"> & {
        environment: Record<string, string>;
    }
) {
    if (!path.isAbsolute(options.command) || !path.isAbsolute(options.cwd))
        throw new Error("Installation leases require absolute package paths.");
    const stopped = new AbortController();
    const connection = new RpcProcess({
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        env: computerChildEnvironment(options.environment),
        // The caller closes this only AFTER connection/controller cleanup. A run's
        // abort signal must not release the installation guard during that cleanup.
        signal: stopped.signal,
        stopViaStdin: true,
        requireCleanExit: true,
        windowsHide: true,
        requestTimeoutMs: 3000,
        maxFrameBytes: 1024,
        onRequest: () => {
            stopped.abort();
            return Promise.reject(
                new Error("An installation lease cannot request tools.")
            );
        },
    });
    const unsubscribe = connection.subscribe(() => stopped.abort());
    const close = async () => {
        stopped.abort();
        unsubscribe();
        await connection.close();
    };
    try {
        v.parse(
            v.strictObject({ protocol: v.literal(1) }),
            await connection.request("initialize", {})
        );
        connection.signal.throwIfAborted();
        return { signal: connection.signal, close };
    } catch (error) {
        await close();
        throw error;
    }
}
