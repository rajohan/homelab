import type { Readable } from "node:stream";

import { readComputerCredential } from "./credentials";

/**
 * Read one bounded ticket without terminal echo, command arguments or a persistent file.
 * @param input - Terminal or explicitly piped standard input.
 * @param signal - Caller cancellation; the prompt also expires after five minutes.
 * @returns One validated pairing ticket; terminal mode and listeners are restored on every exit.
 */
export async function readComputerTicket(
    input: Readable & {
        isTTY?: boolean;
        isRaw?: boolean;
        setRawMode?: (mode: boolean) => unknown;
    },
    signal: AbortSignal
): Promise<string> {
    const raw = input.isRaw === true;
    const result = Promise.withResolvers<string>();
    let value = "";
    const fail = () => result.reject(new Error("Pairing input stopped or invalid."));
    const consume = (chunk: Buffer | string) => {
        for (const char of chunk.toString()) {
            if (char === "\u0003") {
                fail();
                return;
            }
            if (char === "\r" || char === "\n") {
                if (readComputerCredential(value, "pair")) result.resolve(value);
                else fail();
                return;
            }
            if (char === "\u007F" || char === "\b") value = value.slice(0, -1);
            else value += char;
            if (value.length > 128) {
                fail();
                return;
            }
        }
    };
    const timer = setTimeout(fail, 300_000);
    try {
        signal.throwIfAborted();
        if (input.isTTY) {
            if (!input.setRawMode)
                throw new Error("A private terminal prompt is unavailable.");
            input.setRawMode(true);
        }
        signal.addEventListener("abort", fail, { once: true });
        input.on("data", consume);
        input.once("end", fail);
        input.once("error", fail);
        input.resume();
        return await result.promise;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", fail);
        input.off("data", consume);
        input.off("end", fail);
        input.off("error", fail);
        input.pause();
        if (input.isTTY) input.setRawMode?.(raw);
    }
}
