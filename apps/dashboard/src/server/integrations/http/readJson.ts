/**
 * Decode a bounded upstream body without exposing raw provider error text.
 * @param response - Successful response owned by the caller.
 * @param maximumBytes - Hard response budget including streaming/chunked bodies.
 * @returns Untrusted JSON for provider-specific schema validation.
 */
export async function readBoundedJson(
    response: Response,
    maximumBytes = 2_000_000
): Promise<unknown> {
    return JSON.parse(
        new TextDecoder().decode(await readBoundedBytes(response, maximumBytes))
    ) as unknown;
}

/**
 * Read exact bounded upstream bytes for content-hash verification before JSON parsing.
 * @param response - Successful response owned by the caller.
 * @param maximumBytes - Hard streaming budget before allocation and decoding.
 * @returns The unmodified response body; the stream is always closed.
 */
export async function readBoundedBytes(
    response: Response,
    maximumBytes: number
): Promise<Uint8Array> {
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("Integration request failed");
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const bytes: unknown = chunk.value;
            if (!(bytes instanceof Uint8Array))
                throw new Error("Invalid integration response stream");
            length += bytes.byteLength;
            if (length > maximumBytes)
                throw new Error("Integration response exceeds its budget");
            parts.push(bytes);
        }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
            body.set(part, offset);
            offset += part.byteLength;
        }
        return body;
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
}
