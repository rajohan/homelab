import type { TestGroup } from "./inventory";

/**
 * Build a complete test partition with its own runtime and coverage directory.
 * @param group - The test partition to run.
 * @param files - The complete nonempty partition inventory.
 * @param coverage - Whether to emit coverage.
 * @returns Arguments for the pinned Bun test runner.
 */
export function testArguments(
    group: TestGroup,
    files: readonly string[],
    coverage: boolean
): string[] {
    if (files.length === 0) throw new Error("A test group cannot be empty");
    return [
        "test",
        group === "integration" ? "--parallel=4" : "--parallel=2",
        "--no-isolate",
        ...(group === "component" ? ["--preload", "./tests/dom.ts"] : []),
        ...(coverage && group !== "integration"
            ? ["--preload", "./tests/coverage.ts"]
            : []),
        ...(coverage
            ? [
                  "--coverage",
                  "--coverage-reporter=text",
                  "--coverage-reporter=lcov",
                  `--coverage-dir=coverage/${group}`,
              ]
            : []),
        ...files.map((file) => `./${file}`),
    ];
}
