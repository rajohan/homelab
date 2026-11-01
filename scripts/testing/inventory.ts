export type TestGroup = "unit" | "component" | "integration";

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
        .map((file) => file.replaceAll("\\", "/"))
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
