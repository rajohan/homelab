import type { InfrastructureSnapshot } from "@homelab/contracts/operations";
import * as v from "valibot";

const sampleSchema = v.object({ value: v.tuple([v.number(), v.string()]) });
const vectorSchema = v.object({
    status: v.literal("success"),
    data: v.object({
        resultType: v.literal("vector"),
        result: v.pipe(v.array(sampleSchema), v.maxLength(1)),
    }),
});

async function boundedJson(response: Response): Promise<unknown> {
    if (!response.ok || !response.body) throw new Error("Metrics request failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const result = await reader.read();
            if (result.done) break;
            const chunk: unknown = result.value;
            if (!(chunk instanceof Uint8Array)) throw new Error("Invalid response chunk");
            size += chunk.byteLength;
            if (size > 65_536) throw new Error("Metrics response exceeds its budget");
            chunks.push(chunk);
        }
        return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
}

/**
 * Read fixed aggregate queries from a configured Prometheus-compatible metrics API.
 * @param configuration - Trusted deployment URL and optional read-only credential.
 * @param signal - Job cancellation and deadline signal.
 * @returns A compact snapshot without labels, raw metrics or upstream response text.
 */
export async function collectMetrics(
    configuration: { url: string; token: string | undefined },
    signal: AbortSignal
): Promise<InfrastructureSnapshot> {
    const query = async (expression: string): Promise<number | null> => {
        const url = new URL(configuration.url.replace(/\/$/, "") + "/api/v1/query");
        url.searchParams.set("query", expression);
        const response = await fetch(url, {
            signal,
            redirect: "error",
            headers: configuration.token
                ? { Authorization: `Bearer ${configuration.token}` }
                : {},
        });
        const value = v.parse(vectorSchema, await boundedJson(response));
        const sample = value.data.result[0];
        if (!sample) return null;
        const count = Number(sample.value[1]);
        if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count))
            throw new Error("Invalid metric aggregate");
        return count;
    };
    const [reachableTargets, totalTargets, firingAlerts] = await Promise.all([
        query("sum(up == 1)"),
        query("count(up)"),
        query('sum(ALERTS{alertstate="firing",alertname!="Watchdog"})'),
    ]);
    if (totalTargets === null) throw new Error("No monitoring targets were reported");
    return {
        capturedAt: new Date().toISOString(),
        reachableTargets: reachableTargets ?? 0,
        totalTargets,
        firingAlerts,
    };
}
