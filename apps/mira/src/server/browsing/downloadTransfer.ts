import * as v from "valibot";

export const browserDownloadLimit = 25 * 1024 * 1024;
export const browserDownloadTotal = 100 * 1024 * 1024;
export const browserDownloadCount = 16;
const chunkBytes = 24 * 1024;
export const browserDownloadHeaderSchema = v.strictObject({
    size: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(browserDownloadLimit)
    ),
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
export const browserDownloadOffsetSchema = v.strictObject({
    offset: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(0),
        v.maxValue(browserDownloadLimit)
    ),
});
const partSchema = v.strictObject({
    ...browserDownloadOffsetSchema.entries,
    data: v.pipe(
        v.string(),
        v.minLength(4),
        v.maxLength(32 * 1024),
        v.regex(/^[A-Za-z0-9+/]*={0,2}$/)
    ),
});
export interface BrowserDownloadFile {
    bytes: Uint8Array;
    sha256: string;
}

/** Retain one completed download until its exact private recipient consumes every byte. */
export class BrowserDownloadTransfer {
    private pending: { file: BrowserDownloadFile; offset: number } | undefined;

    /** Report whether ordinary commands must wait for download consumption.
     * @returns Whether a completed file is still being transferred.
     */
    get active() {
        return Boolean(this.pending);
    }

    /** Retain a verified native artifact without accepting a website filename or path.
     * @param file - Completed bytes and digest from the private native adapter.
     * @returns A bounded metadata header, never the whole file in one reply.
     */
    begin(file: BrowserDownloadFile) {
        if (this.pending) throw new Error("A browser download is already in progress.");
        const header = v.parse(browserDownloadHeaderSchema, {
            size: file.bytes.length,
            sha256: file.sha256,
        });
        if (
            new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex") !==
            header.sha256
        )
            throw new Error("The browser download digest does not match.");
        this.pending = { file, offset: 0 };
        return header;
    }

    /** Consume the next contiguous chunk once; duplicate offsets cannot replay file content.
     * @param input - Exact next offset requested by the trusted host.
     * @returns One base64 chunk within the normal private message ceiling.
     */
    take(input: unknown) {
        const { offset } = v.parse(browserDownloadOffsetSchema, input);
        const pending = this.pending;
        if (!pending || offset !== pending.offset || offset >= pending.file.bytes.length)
            throw new Error("Invalid browser download offset.");
        const bytes = pending.file.bytes.subarray(offset, offset + chunkBytes);
        pending.offset += bytes.length;
        return { offset, data: Buffer.from(bytes).toString("base64") };
    }

    /** Acknowledge complete consumption and discard retained bytes; incomplete transfers cannot finish. */
    finish(): void {
        const pending = this.pending;
        this.pending = undefined;
        if (!pending || pending.offset !== pending.file.bytes.length)
            throw new Error("Browser download transfer is incomplete.");
    }

    /** Drop pending bytes immediately on private connection shutdown. */
    clear(): void {
        this.pending = undefined;
    }
}

/** Collect bounded chunks from an untrusted worker, checking offsets, canonical encoding and final digest. */
export class BrowserDownloadReceiver {
    private readonly bytes: Uint8Array;
    private offset = 0;
    private finished = false;
    readonly header: v.InferOutput<typeof browserDownloadHeaderSchema>;

    /** Validate the announced size before allocating any receive buffer.
     * @param input - Worker metadata header with no paths or suggested executable names.
     */
    constructor(input: unknown) {
        this.header = v.parse(browserDownloadHeaderSchema, input);
        this.bytes = new Uint8Array(this.header.size);
    }

    /** Verify one chunk before copying it into the bounded receive buffer.
     * @param input - Untrusted private chunk, never database or Chat JSON.
     */
    accept(input: unknown): void {
        const part = v.parse(partSchema, input),
            decoded = Buffer.from(part.data, "base64");
        if (
            this.finished ||
            part.offset !== this.offset ||
            decoded.length === 0 ||
            decoded.length > chunkBytes ||
            this.offset + decoded.length > this.bytes.length ||
            decoded.toString("base64") !== part.data
        )
            throw new Error("Invalid browser download chunk.");
        this.bytes.set(decoded, this.offset);
        this.offset += decoded.length;
    }

    /** Consume a complete digest-verified artifact once.
     * @returns Exact private bytes for the trusted host's normal file validation and import.
     */
    finish(): BrowserDownloadFile {
        if (this.finished) throw new Error("Browser download was already consumed.");
        this.finished = true;
        if (
            this.offset !== this.bytes.length ||
            new Bun.CryptoHasher("sha256").update(this.bytes).digest("hex") !==
                this.header.sha256
        )
            throw new Error("Browser download is incomplete or changed.");
        return { bytes: this.bytes, sha256: this.header.sha256 };
    }
}
