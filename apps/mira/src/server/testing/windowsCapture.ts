import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { openWindowsComputerProcess } from "../computer/process";
import type { ComputerWindowPort } from "../computer/session";
import {
    computerEnvironment,
    hostedComputerQualificationEnvironment,
} from "../config/environment";
import { RpcProcess } from "../runtime/rpcProcess";

/**
 * Qualify native window-only capture using only owned synthetic windows in a hosted VM.
 * @param directory - Caller-owned build directory containing the fixed capture and fixture executables.
 * @param workerDirectory - Optional inventory-verified package to qualify through the full worker.
 * @returns A content-free receipt after pixel checks, capture refusals and fixture shutdown.
 */
export async function qualifyWindowsCapture(directory: string, workerDirectory?: string) {
    if (
        process.platform !== "win32" ||
        !hostedComputerQualificationEnvironment() ||
        !path.isAbsolute(directory)
    )
        throw new Error(
            "Window capture qualification requires disposable hosted Windows."
        );
    const capture = path.join(directory, "mira-window-capture.exe");
    const executable = path.join(directory, "mira-capture-fixture.exe");
    const environment = computerEnvironment();
    const fixture = new RpcProcess({
        command: executable,
        args: [],
        cwd: directory,
        env: {
            ...environment,
            GITHUB_ACTIONS: "true",
            RUNNER_ENVIRONMENT: "github-hosted",
        },
        windowsHide: false,
        stopViaStdin: true,
        requireCleanExit: true,
        requestTimeoutMs: 5000,
        maxFrameBytes: 8192,
        onRequest: () =>
            Promise.reject(new Error("The capture fixture cannot request tools.")),
    });
    let worker: ComputerWindowPort | undefined;
    const signal = AbortSignal.timeout(30_000);
    try {
        const state = v.parse(
            v.strictObject({
                pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
                windowId: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/)),
                started: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/)),
            }),
            await fixture.request("state", {})
        );
        const args = [String(state.pid), state.windowId, state.started];
        if (workerDirectory)
            worker = await openWindowsComputerProcess(
                {
                    executable: await realpath(executable),
                    pid: state.pid,
                    windowId: state.windowId,
                    startedAt: state.started,
                    delivery: "foreground",
                    mode: "view",
                },
                { directory: workerDirectory, environment, signal }
            );
        const invoke = (arguments_: string[]) =>
            spawnSync(capture, arguments_, {
                cwd: directory,
                env: environment,
                windowsHide: true,
                timeout: 10_000,
                maxBuffer: 3 * 1024 * 1024,
                stdio: ["pipe", "pipe", "pipe"],
            });
        const take = () => {
            const result = invoke(args);
            if (
                result.error ||
                result.signal ||
                result.status !== 0 ||
                !Buffer.isBuffer(result.stdout)
            ) {
                const code =
                    result.stderr?.toString().match(/0x[0-9A-F]{8}/)?.[0] ??
                    "unavailable";
                throw new Error(
                    `Window-only capture failed (status ${result.status}, code ${code}).`
                );
            }
            return result.stdout;
        };
        const denied = (arguments_: string[]) => {
            const result = invoke(arguments_);
            if (
                result.error ||
                result.signal ||
                result.status !== 1 ||
                !Buffer.isBuffer(result.stdout) ||
                result.stdout.length > 0
            )
                throw new Error("Capture refusal did not exit cleanly without pixels.");
        };
        const validate = async () => {
            const frame = await worker?.observe(signal);
            const item = frame?.content.content.find((value) => value.type === "image");
            const image = worker
                ? Buffer.from(item?.type === "image" ? item.data : "", "base64")
                : take();
            if (
                image.length > 4500 ||
                image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
            )
                throw new Error("Unexpected synthetic fixture PNG.");
            v.parse(
                v.strictObject({ targetPixels: v.literal(true) }),
                await fixture.request("image", { png: image.toString("base64") })
            );
        };
        await validate();
        v.parse(
            v.strictObject({ covered: v.literal(true) }),
            await fixture.request("cover", {})
        );
        await Bun.sleep(250);
        await validate();
        denied([String(process.pid), state.windowId, state.started]);
        denied([String(state.pid), state.windowId, String(BigInt(state.started) + 1n)]);
        denied([...args, "unexpected"]);
        denied(["invalid", state.windowId, state.started]);
        v.parse(
            v.strictObject({ minimized: v.literal(true) }),
            await fixture.request("minimize", {})
        );
        denied(args);
        v.parse(
            v.strictObject({ closed: v.literal(true) }),
            await fixture.request("close", {})
        );
        denied(args);
        v.parse(
            v.strictObject({ pid: v.literal(state.pid) }),
            await fixture.request("alive", {})
        );
        return {
            windowOnly: true,
            occluded: true,
            identityDenied: true,
            minimizedDenied: true,
            closedDenied: true,
            packaged: Boolean(worker),
        };
    } finally {
        try {
            await worker?.close();
        } finally {
            await fixture.close();
        }
    }
}

if (import.meta.main) {
    const [directory, workerDirectory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length > 0)
        throw new Error("Provide one owned build directory.");
    process.stdout.write(
        JSON.stringify(await qualifyWindowsCapture(directory, workerDirectory)) + "\n"
    );
}
