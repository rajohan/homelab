import path from "node:path";

import * as v from "valibot";

const absolute = v.pipe(
    v.string(),
    v.minLength(1),
    v.check((value) => path.posix.isAbsolute(value) && !/[\r\n\0]/.test(value))
);
const name = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/));
const targetSchema = v.strictObject({
    id: name,
    label: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
    host: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/)),
    user: v.pipe(v.string(), v.regex(/^[a-z_][a-z0-9_-]{0,63}$/)),
    port: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535)),
        22
    ),
    identityFile: absolute,
    knownHostsFile: absolute,
});
const schema = v.strictObject({
    owner: v.pipe(v.string(), v.uuid()),
    targets: v.pipe(
        v.array(targetSchema),
        v.minLength(1),
        v.maxLength(64),
        v.check((items) => new Set(items.map((item) => item.id)).size === items.length)
    ),
});
export type MiraOperationsConfiguration = v.InferOutput<typeof schema>;
export type MiraOperationsTarget = v.InferOutput<typeof targetSchema>;

/** Load explicitly provisioned host authority; no desktop keys or SSH config are discovered.
 * @param file - Optional operator-owned JSON file mounted only in the trusted executor.
 * @returns Validated owner and SSH destinations, or undefined when administration is not provisioned.
 */
export async function readMiraOperations(
    file?: string
): Promise<MiraOperationsConfiguration | undefined> {
    if (!file) return undefined;
    v.parse(absolute, file);
    return v.parse(schema, await Bun.file(file).json());
}

/** Bind an approval to the exact configured destination and credential paths.
 * @param owner - Operator who owns this configuration.
 * @param target - Operator-controlled connection, never supplied by a model.
 * @returns Nonsecret fingerprint invalidated by any target change.
 */
export function miraOperationsBinding(
    owner: string,
    target: MiraOperationsTarget
): string {
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify({ owner, ...target }))
        .digest("hex");
}
