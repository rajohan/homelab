import type { Readable } from "node:stream";

/**
 * Bind a supervised connection to its launcher's private stdin lifetime.
 * @param input - Redirected parent pipe; it carries no commands or credentials during a run.
 * @param abort - Abort the same connection/controller lifetime used by normal local stop.
 * @returns Listener cleanup after all connection work and native children have been reaped.
 */
export function watchComputerParent(input: Readable, abort: () => void): () => void {
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        input.pause();
        abort();
    };
    input.on("end", stop);
    input.on("close", stop);
    input.on("error", stop);
    input.on("data", stop);
    input.resume();
    if (input.readableEnded || input.destroyed) stop();
    return () => {
        input.off("end", stop);
        input.off("close", stop);
        input.off("error", stop);
        input.off("data", stop);
        input.pause();
    };
}
