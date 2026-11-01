/**
 * Read bounded UTF-8 server-sent data events, requiring an explicit terminator before accepting completion.
 * @param response - Successful streaming inference response with an owned body.
 * @param signal - Current turn cancellation and deadline.
 * @yields {unknown} Provider data payloads, excluding comments and the terminal marker.
 * @returns Completion only after the provider terminator; truncation throws.
 */
export async function* syntheticEvents(
    response: Response,
    signal: AbortSignal
): AsyncGenerator<unknown> {
    if (
        !response.body ||
        !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("text/event-stream")
    )
        throw new Error("Synthetic did not return an event stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let bytes = 0;
    let data: string[] = [];
    let eventBytes = 0;
    const abort = () => {
        void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done)
                throw new Error("Synthetic disconnected before completing its response.");
            const value: unknown = chunk.value;
            if (!(value instanceof Uint8Array))
                throw new Error("Synthetic returned an invalid stream chunk.");
            bytes += value.byteLength;
            if (bytes > 4 * 1024 * 1024)
                throw new Error("Synthetic response exceeds its limit.");
            buffer += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, end).replace(/\r$/, "");
                buffer = buffer.slice(end + 1);
                if (line === "") {
                    if (data.length > 0) {
                        const payload = data.join("\n");
                        data = [];
                        eventBytes = 0;
                        if (payload === "[DONE]") return;
                        yield JSON.parse(payload) as unknown;
                    }
                } else if (line.startsWith("data:")) {
                    const value = line.slice(5).replace(/^ /, "");
                    eventBytes += Buffer.byteLength(value);
                    if (eventBytes > 512 * 1024)
                        throw new Error("Synthetic event exceeds its limit.");
                    data.push(value);
                }
            }
            if (buffer.length > 512 * 1024)
                throw new Error("Synthetic event line exceeds its limit.");
        }
    } finally {
        signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
