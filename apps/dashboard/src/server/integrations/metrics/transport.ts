import * as v from "valibot";

export interface MetricsConfiguration {
    readonly url: string;
    readonly token: string | undefined;
}

const pointSchema = v.tuple([v.number(), v.string()]);
const labelsSchema = v.record(v.string(), v.string());
const matrixSampleSchema = v.object({
    metric: labelsSchema,
    values: v.pipe(v.array(pointSchema), v.maxLength(750)),
});
const responseSchema = v.object({
    status: v.literal("success"),
    data: v.variant("resultType", [
        v.object({
            resultType: v.literal("vector"),
            result: v.pipe(
                v.array(v.object({ metric: labelsSchema, value: pointSchema })),
                v.maxLength(8000)
            ),
        }),
        v.object({
            resultType: v.literal("matrix"),
            result: v.pipe(v.array(matrixSampleSchema), v.maxLength(8)),
        }),
    ]),
});

/**
 * Read a bounded response from the configured monitoring service, never a browser URL.
 * @param configuration - Trusted endpoint and optional scoped read credential.
 * @param expression - A server-owned, fixed or safely constructed PromQL expression.
 * @param signal - The caller's cancellation and deadline signal.
 * @param live - Read current samples with a one-second ingestion allowance, leaving history unchanged.
 * @returns A validated vector or matrix; upstream bodies are never included in errors.
 */
export async function queryMetrics(
    configuration: MetricsConfiguration,
    expression: string,
    signal: AbortSignal,
    live = false
) {
    const url = new URL(`${configuration.url.replace(/\/$/, "")}/api/v1/query`);
    url.searchParams.set("query", expression);
    if (live) url.searchParams.set("latency_offset", "1s");
    const response = await fetch(url, {
        signal,
        redirect: "error",
        headers: configuration.token
            ? { Authorization: `Bearer ${configuration.token}` }
            : {},
    });
    if (!response.ok || !response.body) throw new Error("Monitoring request failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const value: unknown = chunk.value;
            if (!(value instanceof Uint8Array))
                throw new Error("Invalid monitoring response chunk");
            size += value.byteLength;
            if (size > 2_000_000)
                throw new Error("Monitoring response exceeds its budget");
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const text = new TextDecoder().decode(bytes);
        return v.parse(responseSchema, JSON.parse(text) as unknown).data;
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
}
