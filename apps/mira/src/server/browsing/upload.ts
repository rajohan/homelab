import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

export const browserUploadLimit = 25 * 1024 * 1024;
export const browserUploadCount = 16;

export const browserUploadActionSchema = v.strictObject({
    observationId: v.pipe(v.string(), v.uuid()),
    ref: v.pipe(v.string(), v.regex(/^p[0-9]{1,16}:[0-9]{1,6}$/)),
});
const fileSchema = v.strictObject({
    name: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(200),
        v.check(
            (name) =>
                name.isWellFormed() &&
                name.trim().length > 0 &&
                !/[\\/\p{Cc}]/u.test(name) &&
                name !== "." &&
                name !== ".." &&
                Buffer.byteLength(name) <= 200
        )
    ),
    size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(browserUploadLimit)),
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    bytes: v.instance(Uint8Array),
});

/** Exact immutable attachment bytes selected by the trusted host, never a model path. */
export type BrowserUploadFile = v.InferOutput<typeof fileSchema>;

/**
 * Create a private staging area inside the session's disposable directory.
 * @param directory - Existing canonical session directory removed only after Chromium stops.
 * @returns A bounded store retaining assigned files until session cleanup, so delayed form submissions work.
 */
export async function createBrowserUploads(directory: string) {
    if (!path.isAbsolute(directory) || (await realpath(directory)) !== directory)
        throw new Error("Browser uploads require a canonical session directory.");
    const root = path.join(directory, "uploads");
    await mkdir(root, { mode: 0o700 });
    let bytes = 0;
    let count = 0;
    return {
        root,
        stage: async (input: BrowserUploadFile, signal: AbortSignal) => {
            signal.throwIfAborted();
            const file = v.parse(fileSchema, input);
            if (
                file.bytes.byteLength !== file.size ||
                bytes + file.size > browserUploadLimit ||
                count >= browserUploadCount
            )
                throw new Error("Browser upload size or session quota exceeded.");
            // Copy before the first await: a caller must not change approved bytes during staging.
            const content = Uint8Array.from(file.bytes);
            if (
                new Bun.CryptoHasher("sha256").update(content).digest("hex") !==
                file.sha256
            )
                throw new Error(
                    "Browser upload digest does not match the approved file."
                );
            // Reservations are never reclaimed within this session, even after a failed write.
            bytes += file.size;
            count++;
            const selected = path.join(root, crypto.randomUUID());
            await mkdir(selected, { mode: 0o700 });
            signal.throwIfAborted();
            const destination = path.join(selected, file.name);
            const handle = await open(
                destination,
                constants.O_WRONLY |
                    constants.O_CREAT |
                    constants.O_EXCL |
                    constants.O_NOFOLLOW,
                0o400
            );
            try {
                signal.throwIfAborted();
                await handle.writeFile(content);
                signal.throwIfAborted();
            } finally {
                await handle.close();
            }
            return destination;
        },
    };
}
