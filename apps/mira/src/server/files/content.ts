import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

const extractedSchema = v.object({
    text: v.pipe(v.string(), v.maxLength(256_000)),
    pages: v.pipe(v.number(), v.integer(), v.minValue(1)),
    truncated: v.boolean(),
});

/**
 * Parse an uploaded PDF with a hard deadline and bounded output outside the executor loop.
 * @param bytes - Already verified document bytes, no external URL or filesystem path.
 * @param signal - Request or run cancellation.
 * @returns Bounded text, page count and an explicit truncation indicator.
 */
export async function readMiraPdf(
    bytes: Uint8Array,
    signal: AbortSignal
): Promise<v.InferOutput<typeof extractedSchema>> {
    signal.throwIfAborted();
    if (bytes.byteLength > 26_214_400) throw new Error("PDF exceeds file limit.");
    const bundled = new URL("miraPdf.js", import.meta.url);
    const entry = fileURLToPath(
        existsSync(bundled) ? bundled : new URL("miraPdf.ts", import.meta.url)
    );
    const child = spawn(process.execPath, [entry], {
        env: {},
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const completion = Promise.withResolvers<void>();
    let output = "";
    let failed = false;
    const stop = () => {
        failed = true;
        child.kill("SIGKILL");
    };
    const deadline = setTimeout(stop, 10_000);
    signal.addEventListener("abort", stop, { once: true });
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        if (output.length + chunk.length > 2_000_000) stop();
        else output += chunk;
    });
    child.on("error", () => {
        failed = true;
    });
    child.stdin.on("error", stop);
    child.on("close", (code) => {
        failed ||= code !== 0;
        completion.resolve();
    });
    child.stdin.end(bytes);
    try {
        await completion.promise;
        signal.throwIfAborted();
        if (failed)
            throw new Error("The PDF could not be read within the document limits.");
        return v.parse(extractedSchema, JSON.parse(output) as unknown);
    } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", stop);
    }
}
