import type { MiraHostCommand } from "@homelab/contracts/miraOperations";

import type { MiraOperationsTarget } from "./configuration";

/** Construct fixed SSH transport arguments; command text is sent only through stdin.
 * @param target - Validated operator-owned destination.
 * @returns An argv array with strict host verification and no inherited SSH configuration.
 */
export function miraOperationsSshArguments(target: MiraOperationsTarget): string[] {
    return [
        "/usr/bin/ssh",
        "-F",
        "/dev/null",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "IdentityAgent=none",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${target.knownHostsFile}`,
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-i",
        target.identityFile,
        "-p",
        String(target.port),
        "-l",
        target.user,
        "--",
        target.host,
        "sh -s",
    ];
}

async function boundedOutput(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let truncated = false;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            const value = decoder.decode(next.value, { stream: true });
            const remaining = 32_000 - text.length;
            text += value.slice(0, remaining);
            if (value.length > remaining) truncated = true;
        }
        const tail = decoder.decode();
        if (text.length + tail.length > 32_000) truncated = true;
        text += tail.slice(0, 32_000 - text.length);
        return { text, truncated };
    } finally {
        reader.releaseLock();
    }
}

function spawnCommand(args: string[], stdin: Uint8Array) {
    return Bun.spawn(args, {
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" },
        stdin,
        stdout: "pipe",
        stderr: "pipe",
    });
}

/** Execute one authorized command without retrying a lost or interrupted SSH operation.
 * @param target - Provisioned host authority held only by the executor.
 * @param command - Exact approved shell program and bounded execution deadline.
 * @param signal - Run cancellation or loss of authority.
 * @param spawn - Process transport; tests substitute a disposable child without changing global process functions.
 * @returns Bounded untrusted output and observed exit code; transport uncertainty throws.
 */
export async function executeMiraHostCommand(
    target: MiraOperationsTarget,
    command: MiraHostCommand,
    signal: AbortSignal,
    spawn = spawnCommand
) {
    signal.throwIfAborted();
    const deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(command.timeoutSeconds * 1000),
    ]);
    const child = spawn(miraOperationsSshArguments(target), new TextEncoder().encode(command.command + "\n"));
    const stop = () => child.kill("SIGKILL");
    deadline.addEventListener("abort", stop, { once: true });
    if (deadline.aborted) stop();
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            boundedOutput(child.stdout),
            boundedOutput(child.stderr),
        ]);
        deadline.throwIfAborted();
        if (exitCode === 255) throw new Error("SSH outcome was not confirmed.");
        return {
            exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
            trust: "untrusted_host_output",
        };
    } finally {
        deadline.removeEventListener("abort", stop);
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
    }
}
