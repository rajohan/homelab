import { timingFiles, type TestGroup } from "./inventory";

export function testArguments(
    group: TestGroup,
    files: readonly string[],
    coverage: boolean,
    timingsPath: string = timingFiles[group],
    update = false
): string[] {
    if (files.length === 0) throw new Error("A test group cannot be empty");
    return [
        "test",
        "--parallel=2",
        "--no-isolate",
        `--timings=${timingsPath}`,
        ...(update ? ["--update-timings"] : []),
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
