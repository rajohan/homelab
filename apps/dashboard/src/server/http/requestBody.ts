export const dashboardTransportBodyLimit = 26_214_400;

/**
 * Buffer API bodies within a route-specific byte budget, including chunked requests.
 * @param request - Original transport request, before any consumer reads its body.
 * @returns A replayable bounded request, or null when its declared or actual body is too large.
 */
export async function boundedDashboardRequest(request: Request): Promise<Request | null> {
    const maximum =
        request.method === "POST" &&
        new URL(request.url).pathname === "/api/automation/updates.publish"
            ? 950_000
            : 65_536;
    return boundedRequestBody(request, maximum);
}

/**
 * Buffer a request within an explicit byte budget, including chunked uploads.
 * @param request - Transport body; large-file callers must authenticate first.
 * @param maximum - Route-specific maximum, never supplied by the browser.
 * @returns A replayable request, or null after cancelling an oversized body.
 */
export async function boundedRequestBody(
    request: Request,
    maximum: number
): Promise<Request | null> {
    if (Number(request.headers.get("content-length")) > maximum) {
        await request.body?.cancel();
        return null;
    }
    if (!request.body) return request;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const result = await reader.read();
            if (result.done) break;
            const value: unknown = result.value;
            if (!(value instanceof Uint8Array))
                throw new Error("Invalid request body chunk");
            length += value.byteLength;
            if (length > maximum) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new Request(request, { method: request.method, body });
}
