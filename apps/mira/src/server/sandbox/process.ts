import { spawn } from "node:child_process";

export interface SandboxProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
}
/**
 * Run a bounded argv-only process in an explicitly supplied sandbox directory and environment.
 * @param command - Executable and arguments, never a shell expression.
 * @param options - Explicit cwd, clean environment, cancellation and output/time limits.
 * @returns Bounded output and termination evidence. Ordinary process-group descendants are killed on exit.
 */
export async function runSandboxProcess(
    command: readonly string[],
    options: {
        cwd: string;
        env: Record<string, string>;
        signal: AbortSignal;
        timeoutMs: number;
        maxBytes?: number;
    }
): Promise<SandboxProcessResult> {
    options.signal.throwIfAborted();
    const maxBytes = options.maxBytes ?? 524_288;
    if (
        !command[0] ||
        !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 720_000 ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 1_048_576
    )
        throw new Error("Invalid sandbox process bounds.");
    const child = spawn(command[0], command.slice(1), {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
    });
    let stdout = Buffer.alloc(0),
        stderr = Buffer.alloc(0);
    let truncated = false,
        timedOut = false;
    const take = (previous: Buffer, chunk: Buffer, limit: number) => {
        const combined = Buffer.concat([previous, chunk]);
        if (combined.length > limit) truncated = true;
        return Buffer.from(combined.subarray(Math.max(0, combined.length - limit)));
    };
    child.stdout.on("data", (chunk: Buffer) => {
        stdout = take(stdout, chunk, Math.ceil(maxBytes / 2));
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderr = take(stderr, chunk, Math.floor(maxBytes / 2));
    });
    const kill = () => {
        if (child.pid && process.platform !== "win32") {
            try {
                process.kill(-child.pid, "SIGKILL");
            } catch {
                // The process group may already have exited.
            }
        } else child.kill("SIGKILL");
    };
    child.once("exit", kill);
    const abort = () => {
        kill();
        child.stdout.destroy();
        child.stderr.destroy();
    };
    const timer = setTimeout(() => {
        timedOut = true;
        abort();
    }, options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    try {
        const exitCode = await new Promise<number>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => resolve(code ?? 137));
        });
        return {
            exitCode,
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
            truncated,
            timedOut,
        };
    } finally {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
        kill();
        child.stdout.destroy();
        child.stderr.destroy();
    }
}
