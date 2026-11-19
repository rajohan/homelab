import type { MiraHostCommand } from "@homelab/contracts/miraOperations";
import { Effect, Semaphore } from "effect";

import { MiraFailure } from "../data/context";
import type { MiraOperationsTarget } from "./configuration";

interface HostCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
    trust: string;
}

/** An observed command failure with private output kept separate from its operational message. */
export class MiraHostCommandFailure extends Error {
    readonly result: HostCommandResult;

    /**
     * Preserve observed diagnostics without copying them into operational error text.
     * @param result - Observed exit and bounded output; failure does not imply partial changes were undone.
     */
    constructor(result: HostCommandResult) {
        super(
            `Host command exited with status ${result.exitCode}. Inspect the output and any partial effects before retrying.`
        );
        this.name = "MiraHostCommandFailure";
        this.result = result;
    }
}

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
        "printf R && exec sh -s",
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

// Bound unauthenticated connections. Established commands release their slot immediately.
const connections = Semaphore.makeUnsafe(4);

function spawnCommand(args: string[]) {
    return Bun.spawn(args, {
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" },
        stdin: "pipe",
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
    const deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(command.timeoutSeconds * 1000),
    ]);
    let child: ReturnType<typeof spawnCommand> | undefined;
    let sent = false;
    const stop = () => child?.kill("SIGKILL");
    deadline.addEventListener("abort", stop, { once: true });
    try {
        const connected = await Effect.runPromise(
            connections.withPermit(
                Effect.tryPromise(async () => {
                    deadline.throwIfAborted();
                    child = spawn(miraOperationsSshArguments(target));
                    const reader = child.stdout.getReader();
                    try {
                        // Only the fixed remote wrapper can write before we supply stdin.
                        const { value } = await reader.read();
                        if (value?.length !== 1 || value[0] !== 0x52)
                            throw new Error("Missing SSH readiness acknowledgement.");
                        return child;
                    } finally {
                        reader.releaseLock();
                    }
                })
            ),
            { signal: deadline }
        );
        deadline.throwIfAborted();
        sent = true;
        const [exitCode, stdout, stderr] = await Promise.all([
            connected.exited,
            boundedOutput(connected.stdout),
            boundedOutput(connected.stderr),
            (async () => {
                await connected.stdin.write(command.command + "\n");
                await connected.stdin.end();
            })(),
        ]);
        deadline.throwIfAborted();
        if (exitCode === 255) throw new Error("SSH outcome was not confirmed.");
        const result = {
            exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
            trust: "untrusted_host_output",
        };
        if (exitCode !== 0) throw new MiraHostCommandFailure(result);
        return result;
    } catch (error) {
        if (!sent)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "The SSH connection did not become ready. No command was sent."
            );
        throw error;
    } finally {
        deadline.removeEventListener("abort", stop);
        if (child?.exitCode === null) stop();
        await child?.exited;
    }
}
