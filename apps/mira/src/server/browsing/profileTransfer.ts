import * as v from "valibot";

import { browserProfileSnapshotBytes } from "./profile";

export const browserProfileChunkBytes = 32 * 1024;
export const browserProfilePartSchema = v.strictObject({
    data: v.pipe(
        v.string(),
        v.maxLength(browserProfileChunkBytes),
        v.regex(/^[A-Za-z0-9+/]*={0,2}$/)
    ),
    last: v.boolean(),
});

/** Accumulate one private snapshot with a fixed aggregate limit and explicit completion. */
export class BrowserProfileTransfer {
    private chunks: string[] = [];
    private length = 0;
    private finished = false;

    /**
     * Accept the next private chunk; empty nonfinal and post-completion messages are refused.
     * @param input - Untrusted chunk from the private worker/host channel.
     * @returns The complete snapshot (null for a new profile), or undefined while incomplete.
     */
    accept(input: unknown): string | null | undefined {
        const part = v.parse(browserProfilePartSchema, input);
        if (this.finished || (!part.last && !part.data))
            throw new Error("Invalid browser profile transfer.");
        this.length += part.data.length;
        if (this.length > browserProfileSnapshotBytes)
            throw new Error("Browser profile transfer exceeds its limit.");
        this.chunks.push(part.data);
        if (!part.last) return;
        this.finished = true;
        const snapshot = this.chunks.join("");
        this.chunks = [];
        return snapshot || null;
    }
}

/**
 * Split one already-bounded snapshot without widening ordinary worker message limits.
 * @param snapshot - Private base64 value, or null for a new profile.
 * @returns The iterator over bounded private chunks.
 * @yields {{data: string, last: boolean}} Ordered chunks ending in exactly one final marker.
 */
export function* browserProfileParts(snapshot: string | null) {
    const data = snapshot === null ? "" : snapshot;
    if (data.length > browserProfileSnapshotBytes)
        throw new Error("Browser profile transfer exceeds its limit.");
    for (let offset = 0; offset < data.length; offset += browserProfileChunkBytes)
        yield {
            data: data.slice(offset, offset + browserProfileChunkBytes),
            last: offset + browserProfileChunkBytes >= data.length,
        };
    if (!data) yield { data: "", last: true };
}
