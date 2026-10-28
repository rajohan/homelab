import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
    miraComputerUpdateSchema,
    type MiraComputerUpdate,
} from "@homelab/contracts/miraComputerUpdates";
import * as v from "valibot";

/**
 * Transfer a verified installer to the local Windows manager without exposing a temporary path or credential.
 * @param file - Operation-owned staged installer; the receiver must verify its own copy before use.
 * @param metadata - Authenticated release receipt, encoded as one bounded JSON line before the exact bytes.
 * @param output - Private launcher pipe; success requires all bytes to be written and the CLI to exit cleanly.
 * @param signal - Download cancellation; aborting destroys this operation's output pipe.
 * @returns Completion only after the copied bytes still match the release's size and hash.
 */
export async function writeComputerUpdate(
    file: string,
    metadata: MiraComputerUpdate,
    output: Writable,
    signal: AbortSignal
): Promise<void> {
    signal.throwIfAborted();
    const started = performance.now();
    const update = v.parse(miraComputerUpdateSchema, metadata);
    async function* content() {
        const input = await open(file, "r");
        try {
            const stat = await input.stat();
            if (!stat.isFile() || stat.size !== update.size)
                throw new Error("The update transfer changed.");
            const validForMs = Math.floor(
                update.validForMs - (performance.now() - started)
            );
            if (validForMs <= 0) throw new Error("The update transfer expired.");
            yield Buffer.from(JSON.stringify({ ...update, validForMs }) + "\n");
            const buffer = Buffer.alloc(64 * 1024);
            const hash = createHash("sha256");
            let size = 0;
            for (;;) {
                signal.throwIfAborted();
                const next = await input.read(buffer, 0, buffer.length, size);
                if (!next.bytesRead) break;
                size += next.bytesRead;
                if (size > update.size) throw new Error("The update transfer changed.");
                const chunk = Buffer.from(buffer.subarray(0, next.bytesRead));
                hash.update(chunk);
                yield chunk;
            }
            if (size !== update.size || hash.digest("hex") !== update.sha256)
                throw new Error("The update transfer changed.");
            signal.throwIfAborted();
        } finally {
            await input.close();
        }
    }
    const abort = () => {
        output.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
        signal.throwIfAborted();
        await pipeline(Readable.from(content(), { objectMode: false }), output, {
            signal,
            end: false,
        });
    } finally {
        signal.removeEventListener("abort", abort);
    }
}
