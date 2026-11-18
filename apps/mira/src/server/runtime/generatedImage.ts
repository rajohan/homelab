import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import { imageSize } from "image-size";
import * as v from "valibot";

import { miraFileLimit, miraFileType } from "../data/files";

export const imageGenerationEventSchema = v.object({
    threadId: v.string(),
    turnId: v.string(),
    item: v.object({
        type: v.literal("imageGeneration"),
        id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        status: v.string(),
        failure: v.nullish(v.unknown()),
        result: v.optional(v.pipe(v.string(), v.maxLength(35 * 1024 * 1024))),
        savedPath: v.optional(v.pipe(v.string(), v.maxLength(4096))),
    }),
});
export type GeneratedImage = v.InferOutput<typeof imageGenerationEventSchema>["item"];

/**
 * Import a completed native image without accepting arbitrary provider-supplied file paths.
 * @param home - Service-owned Codex home, never a model argument.
 * @param image - Matching completed image item from the current native turn.
 * @returns Bounded passive image bytes and a stable display filename.
 */
export async function readGeneratedImage(home: string, image: GeneratedImage) {
    let bytes: Uint8Array;
    if (image.result) {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.result))
            throw new Error("Native image result is not base64.");
        bytes = Buffer.from(image.result, "base64");
    } else {
        if (!image.savedPath || !path.isAbsolute(image.savedPath))
            throw new Error("Native image has no readable output.");
        const root = await realpath(path.join(home, "generated_images"));
        const file = await realpath(image.savedPath);
        const relative = path.relative(root, file);
        if (
            !relative ||
            path.isAbsolute(relative) ||
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            file !== image.savedPath
        )
            throw new Error("Native image is outside generated image storage.");
        const handle = await open(
            file,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size === 0 || stat.size > miraFileLimit)
                throw new Error("Native image exceeds its file limit.");
            const buffer = Buffer.alloc(stat.size + 1);
            let length = 0;
            while (length < buffer.length) {
                const { bytesRead } = await handle.read(
                    buffer,
                    length,
                    buffer.length - length,
                    length
                );
                if (!bytesRead) break;
                length += bytesRead;
            }
            if (length !== stat.size)
                throw new Error("Native image changed while reading.");
            bytes = buffer.subarray(0, length);
        } finally {
            await handle.close();
        }
    }
    if (bytes.length === 0 || bytes.length > miraFileLimit)
        throw new Error("Native image exceeds its file limit.");
    const type = miraFileType(bytes);
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[
        type
    ];
    if (!extension) throw new Error("Native output is not a supported image.");
    const size = imageSize(bytes);
    if (!size.width || !size.height || size.width * size.height > 40_000_000)
        throw new Error("Native image dimensions exceed their limit.");
    const digest = new Bun.CryptoHasher("sha256")
        .update(image.id)
        .digest("hex")
        .slice(0, 16);
    return { name: `generated-${digest}.${extension}`, bytes };
}
