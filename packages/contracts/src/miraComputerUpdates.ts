import * as v from "valibot";

export const miraComputerUpdateSchema = v.strictObject({
    repository: v.pipe(
        v.string(),
        v.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
    ),
    version: v.pipe(v.string(), v.regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/)),
    revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
    size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(512 * 1024 * 1024)),
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    validForMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(300_000)),
});
export type MiraComputerUpdate = v.InferOutput<typeof miraComputerUpdateSchema>;
export const miraComputerUpdateReceiptSchema = v.strictObject({
    update: v.nullable(miraComputerUpdateSchema),
});

/**
 * Derive the one official installer location from validated release identity, never a remote URL field.
 * @param input - Authenticated private-server metadata for a tested Windows release.
 * @returns The fixed GitHub release asset URL; no bearer credentials or query values are embedded.
 */
export function miraComputerUpdateUrl(input: MiraComputerUpdate): string {
    const update = v.parse(miraComputerUpdateSchema, input);
    return `https://github.com/${update.repository}/releases/download/v${update.version}/mira-computer-${update.version}-windows-x64-setup.exe`;
}
