import * as v from "valibot";

import { browserUrl } from "./policy";
import { browserActionSchema, browserWorkerFrame } from "./wire";

export const browserCommandSchema = v.variant("method", [
    v.strictObject({ method: v.literal("observe") }),
    v.strictObject({
        method: v.literal("navigate"),
        url: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
    }),
    v.strictObject({ method: v.literal("act"), input: browserActionSchema }),
]);
export type BrowserCommand = v.InferOutput<typeof browserCommandSchema>;

/**
 * Validate a bounded result again at the durable queue boundary.
 * @param method - Method of the already reserved command, never selected by the result.
 * @param input - Untrusted worker result.
 * @param origins - Original human-approved origin ceiling.
 * @returns A typed image, canonical destination or explicitly unverified input effect.
 */
export function browserCommandResult(
    method: BrowserCommand["method"],
    input: unknown,
    origins: readonly string[]
) {
    if (method === "observe") return browserWorkerFrame(input, origins);
    if (method === "navigate") {
        const result = v.parse(v.strictObject({ url: v.string() }), input);
        return { url: browserUrl(result.url, origins) };
    }
    return v.parse(v.strictObject({ effect: v.literal("unverified") }), input);
}
