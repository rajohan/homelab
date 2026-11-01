import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

import { requireSandboxImage, runDaytonaChecks } from "./harness";
import {
    parseLocalCheckInput,
    parseLocalCheckResult,
    type LocalCheckResult,
} from "./localProtocol";
import { daytonaCheckProfile } from "./profile";

async function readOutput(directory: string, name: string): Promise<string> {
    if ((await realpath(directory)) !== directory)
        throw new Error("Output directory changed.");
    const file = await open(
        path.join(directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 1_048_576)
            throw new Error("Invalid output file.");
        const buffer = Buffer.alloc(1_048_577);
        let count = 0;
        while (count < buffer.length) {
            const { bytesRead } = await file.read(
                buffer,
                count,
                buffer.length - count,
                null
            );
            if (!bytesRead) break;
            count += bytesRead;
        }
        if (count > 1_048_576) throw new Error("Output exceeded its limit.");
        return new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, count)
        );
    } finally {
        await file.close();
    }
}

/**
 * Run the same fixed verification harness used by Daytona, inside a local disposable image.
 * @param value - Validated protocol request with at most one selected UTF-8 input.
 * @param signal - Permanent container interruption.
 * @returns Passive bounded result files; no host paths or provider credentials are accepted.
 */
export async function runLocalCheck(
    value: unknown,
    signal: AbortSignal
): Promise<LocalCheckResult> {
    const { request, input } = parseLocalCheckInput(value);
    await requireSandboxImage();
    signal.throwIfAborted();
    const root = "/tmp/homelab-mira";
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await realpath(root)) !== root) throw new Error("Sandbox root changed.");
    const attempt = path.join(root, request.id);
    await mkdir(attempt, { mode: 0o700 });
    if (input !== null) {
        const directory = path.join(attempt, "inputs");
        await mkdir(directory, { mode: 0o700 });
        const name = "editsSha256" in request ? "edits.json" : "changes.txt";
        const file = await open(
            path.join(directory, name),
            constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW,
            0o600
        );
        try {
            await file.writeFile(input, "utf8");
        } finally {
            await file.close();
        }
    }
    const exitCode = await runDaytonaChecks(request, signal, () => {});
    const names =
        "paths" in request
            ? daytonaCheckProfile.sourceOutputs
            : daytonaCheckProfile.outputs;
    const files = [];
    for (const name of names)
        files.push({ name, text: await readOutput(path.join(attempt, "outputs"), name) });
    return parseLocalCheckResult({ exitCode, files }, request);
}

/**
 * Consume one bounded stdin request and emit one bounded JSON result before exiting.
 * @returns Completion; malformed input and interrupted checks never produce a successful result.
 */
export async function main(): Promise<void> {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const reader = Bun.stdin.stream().getReader();
    const timer = setTimeout(() => {
        controller.abort();
        void reader.cancel();
    }, 15_000);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        // JSON escaping can expand a one-MiB text input to six MiB.
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > 6 * 1_048_576 + 16_384)
                throw new Error("Oversized local check request.");
            chunks.push(value);
            if (value.includes(10)) break;
        }
        clearTimeout(timer);
        controller.signal.throwIfAborted();
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = await runLocalCheck(input, controller.signal);
        process.stdout.write(JSON.stringify(result) + "\n");
        process.exitCode = result.exitCode;
    } finally {
        clearTimeout(timer);
        await reader.cancel();
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
    }
}
if (import.meta.main) {
    try {
        await main();
    } catch {
        process.stderr.write("Local check failed.\n");
        process.exitCode = 1;
    }
}
