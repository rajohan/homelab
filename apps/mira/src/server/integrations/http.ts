/**
 * Bound provider responses while the caller's timeout covers headers and body delivery.
 * @param response - Response from a fixed-origin integration request.
 * @param maximum - Service-owned body budget in bytes.
 * @returns Bounded response bytes without provider error text in thrown messages.
 */
export async function integrationBytes(
    response: Response,
    maximum: number
): Promise<Uint8Array> {
    if (!response.ok || Number(response.headers.get("content-length")) > maximum) {
        await response.body?.cancel();
        throw new Error("The integration request failed or exceeded its response limit.");
    }
    if (!response.body) throw new Error("The integration returned an empty response.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            const chunk: unknown = next.value;
            if (!(chunk instanceof Uint8Array))
                throw new Error("Invalid integration response chunk.");
            bytes += chunk.byteLength;
            if (bytes > maximum) {
                await reader.cancel();
                throw new Error("The integration response exceeded its limit.");
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return buffer;
}

/**
 * Parse a bounded provider JSON body without leaking private diagnostics.
 * @param response - Fixed-origin integration response.
 * @param maximum - Service-owned byte budget.
 * @returns Parsed JSON; invalid content produces a generic error.
 */
export async function integrationJson(
    response: Response,
    maximum: number
): Promise<unknown> {
    const buffer = await integrationBytes(response, maximum);
    try {
        return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(buffer)
        ) as unknown;
    } catch {
        throw new Error("The integration returned invalid JSON.");
    }
}
