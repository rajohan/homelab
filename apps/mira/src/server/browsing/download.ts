import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

const limit = 25 * 1024 * 1024;
const receipt = v.strictObject({
    status: v.literal("completed"),
    download_id: v.pipe(v.string(), v.uuid()),
    bytes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(limit)),
});

/**
 * Create a private destination for native downloads inside the container's quota-bounded temporary disk.
 * @param directory - Private canonical browser session directory; never a product file-store mount.
 * @returns An opaque-artifact reader with byte and count limits; callers remove the session on failure.
 */
export async function createBrowserDownloads(directory: string) {
    if (!path.isAbsolute(directory) || (await realpath(directory)) !== directory)
        throw new Error("Downloads require a canonical session directory.");
    const root = path.join(directory, "downloads");
    await mkdir(root, { mode: 0o700 });
    let count = 0;
    let bytes = 0;
    return {
        root,
        collect: async (input: unknown, signal: AbortSignal) => {
            signal.throwIfAborted();
            const result = v.parse(receipt, input);
            if (++count > 16 || bytes + result.bytes > 100 * 1024 * 1024)
                throw new Error("Browser download session quota exhausted.");
            bytes += result.bytes;
            const entries = await readdir(root);
            if (
                (await realpath(root)) !== root ||
                entries.length !== 1 ||
                entries[0] !== result.download_id
            )
                throw new Error(
                    "The browser download destination contains ambiguous artifacts."
                );
            const destination = path.join(root, result.download_id);
            const file = await open(
                destination,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
            );
            try {
                const before = await file.stat();
                if (
                    !before.isFile() ||
                    before.nlink !== 1 ||
                    before.size !== result.bytes
                )
                    throw new Error(
                        "The browser download is not the completed regular artifact."
                    );
                const data = Buffer.alloc(result.bytes + 1);
                let offset = 0;
                while (offset < data.byteLength) {
                    signal.throwIfAborted();
                    const read = await file.read(
                        data,
                        offset,
                        data.byteLength - offset,
                        offset
                    );
                    if (read.bytesRead === 0) break;
                    offset += read.bytesRead;
                }
                const after = await file.stat();
                if (
                    offset !== result.bytes ||
                    after.size !== before.size ||
                    after.nlink !== 1 ||
                    after.mtimeMs !== before.mtimeMs ||
                    after.ctimeMs !== before.ctimeMs
                )
                    throw new Error("The browser download changed while reading.");
                signal.throwIfAborted();
                const content = data.subarray(0, offset);
                const sha256 = createHash("sha256").update(content).digest("hex");
                await unlink(destination);
                return { bytes: content, sha256 };
            } finally {
                await file.close();
            }
        },
    };
}
