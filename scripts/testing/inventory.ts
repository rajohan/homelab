import * as v from "valibot";

export const timingFiles = {
    unit: ".bun-test-timings.json",
    component: ".bun-browser-test-timings.json",
    integration: ".bun-integration-test-timings.json",
} as const;
export type TestGroup = keyof typeof timingFiles;

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

export async function checkTimings(): Promise<void> {
    const groups = discoverTests();
    for (const group of Object.keys(timingFiles) as TestGroup[])
        assertTimings(await Bun.file(timingFiles[group]).json(), groups[group], group);
}
if (import.meta.main) await checkTimings();
