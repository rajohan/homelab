import * as v from "valibot";

export const timingFiles = {
    unit: ".bun-test-timings.json",
    component: ".bun-browser-test-timings.json",
    integration: ".bun-integration-test-timings.json",
} as const;
export type TestGroup = keyof typeof timingFiles;

/**
 * Discover unit, component and HTTP integration tests without generated build files.
 * @returns The sorted test file inventory for each partition.
 */
export function discoverTests(): Record<TestGroup, string[]> {
    const files = [
        ...new Bun.Glob(
            "{apps,packages,scripts,tests}/**/*.{test,spec}.{ts,tsx}"
        ).scanSync("."),
    ]
        .filter((file) => !file.includes("/node_modules/") && !file.includes("/dist/"))
        .toSorted();
    return {
        unit: files.filter(
            (file) => file.endsWith(".ts") && !file.includes(".integration.")
        ),
        component: files.filter(
            (file) => file.endsWith(".tsx") && !file.includes(".integration.")
        ),
        integration: files.filter((file) => file.includes(".integration.")),
    };
}
const timingsSchema = v.strictObject({
    version: v.literal(1),
    files: v.record(v.string(), v.pipe(v.number(), v.finite(), v.minValue(0))),
});

/**
 * Require timing entries to match the complete test partition without stale files.
 * @param value - The parsed timing-file contents.
 * @param files - The expected test files.
 * @param name - The partition name used in validation errors.
 * @returns The validated timing inventory.
 * @throws {Error} The timing schema or its file inventory is invalid.
 */
export function assertTimings(value: unknown, files: readonly string[], name: string) {
    const timings = v.parse(timingsSchema, value);
    const missing = files.filter((file) => !(file in timings.files));
    const stale = Object.keys(timings.files).filter((file) => !files.includes(file));
    if (
        files.length === 0 ||
        new Set(files).size !== files.length ||
        missing.length > 0 ||
        stale.length > 0
    ) {
        throw new Error(
            `${name} timing inventory mismatch. Run the appropriate test timing update.\nMissing: ${missing.join(", ")}\nStale: ${stale.join(", ")}`
        );
    }
    return timings;
}

/**
 * Validate every committed timing inventory against current test discovery.
 * @returns Completion when all partitions have exact timing coverage.
 */
export async function checkTimings(): Promise<void> {
    const groups = discoverTests();
    for (const group of Object.keys(timingFiles) as TestGroup[])
        assertTimings(await Bun.file(timingFiles[group]).json(), groups[group], group);
}
if (import.meta.main) await checkTimings();
