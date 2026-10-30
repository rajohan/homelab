import * as v from "valibot";

import {
    browserUploadActionSchema,
    browserUploadCount,
    browserUploadFileSchema,
    browserUploadLimit,
    type BrowserUploadFile,
} from "./upload";

const chunkBytes = 24 * 1024;
export const browserUploadHeaderSchema = v.strictObject({
    input: browserUploadActionSchema,
    file: v.omit(browserUploadFileSchema, ["bytes"]),
});
export const browserUploadPartSchema = v.strictObject({
    offset: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(0),
        v.maxValue(browserUploadLimit)
    ),
    data: v.pipe(
        v.string(),
        v.minLength(4),
        v.maxLength(32 * 1024),
        v.regex(/^[A-Za-z0-9+/]*={0,2}$/)
    ),
});

/** Receive one host-approved file at a time over bounded private messages. */
export class BrowserUploadTransfer {
    private pending:
        | {
              header: v.InferOutput<typeof browserUploadHeaderSchema>;
              bytes: Uint8Array;
              offset: number;
          }
        | undefined;
    private count = 0;
    private total = 0;

    /** Report an incomplete file.
     * @returns Whether ordinary browser commands must wait.
     */
    get active() {
        return Boolean(this.pending);
    }

    /** Reserve lifetime quotas before allocating memory for a selected attachment.
     * @param input - Private file header with approved metadata and input identity.
     */
    begin(input: unknown): void {
        const header = v.parse(browserUploadHeaderSchema, input);
        if (
            this.pending ||
            this.count >= browserUploadCount ||
            this.total + header.file.size > browserUploadLimit
        )
            throw new Error("Browser upload transfer quota exceeded.");
        this.count++;
        this.total += header.file.size;
        this.pending = { header, bytes: new Uint8Array(header.file.size), offset: 0 };
    }

    /** Accept contiguous bytes; gaps, duplicates and overflow are refused.
     * @param input - Next bounded private chunk.
     */
    accept(input: unknown): void {
        const part = v.parse(browserUploadPartSchema, input);
        const pending = this.pending;
        const decoded = Buffer.from(part.data, "base64");
        if (
            !pending ||
            part.offset !== pending.offset ||
            decoded.length > chunkBytes ||
            decoded.length === 0 ||
            decoded.toString("base64") !== part.data ||
            pending.offset + decoded.length > pending.bytes.length
        )
            throw new Error("Invalid browser upload chunk.");
        pending.bytes.set(decoded, pending.offset);
        pending.offset += decoded.length;
    }

    /**
     * Consume the complete transfer once, checking the approved digest before native assignment.
     * @returns Exact input identity and verified file bytes; a failed transfer cannot be retried.
     */
    finish() {
        const pending = this.pending;
        this.pending = undefined;
        if (
            !pending ||
            pending.offset !== pending.bytes.length ||
            new Bun.CryptoHasher("sha256").update(pending.bytes).digest("hex") !==
                pending.header.file.sha256
        )
            throw new Error("Incomplete or changed browser upload.");
        return {
            input: pending.header.input,
            file: { ...pending.header.file, bytes: pending.bytes },
        };
    }

    /** Drop incomplete bytes immediately when the private owner connection ends. */
    clear(): void {
        this.pending = undefined;
    }
}

/**
 * Split verified attachment bytes without increasing the normal worker message ceiling.
 * @param file - Immutable bytes copied by the trusted browser port.
 * @returns An iterator of contiguous bounded chunks.
 * @yields {{offset: number, data: string}} Private base64 chunks, never Chat or audit content.
 */
export function* browserUploadParts(file: BrowserUploadFile) {
    for (let offset = 0; offset < file.size; offset += chunkBytes)
        yield {
            offset,
            data: Buffer.from(file.bytes.subarray(offset, offset + chunkBytes)).toString(
                "base64"
            ),
        };
}
