/**
 * List executable source and tooling files independently of which modules tests import.
 * @returns The sorted files that must appear in coverage.
 */
export async function executableSources(): Promise<string[]> {
    const files = [
        ...new Bun.Glob("{apps,packages,scripts}/**/*.{ts,tsx}").scanSync("."),
        ...new Bun.Glob("*.config.ts").scanSync("."),
    ]
        .filter(
            (file) =>
                !/(?:^|\/)(?:node_modules|dist|tests)\//.test(file) &&
                !file.includes("/server/testing/") &&
                !/\.(?:test|spec)\.tsx?$/.test(file) &&
                !file.endsWith(".d.ts")
        )
        .toSorted();
    const transpilers = {
        ts: new Bun.Transpiler({ loader: "ts", target: "bun" }),
        tsx: new Bun.Transpiler({ loader: "tsx", target: "bun" }),
    };
    const result: string[] = [];
    for (const file of files) {
        const transpiler = file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
        if (transpiler.transformSync(await Bun.file(file).text()).trim())
            result.push(file);
    }
    return result;
}

/**
 * Reject a coverage report that omits executable source files.
 * @param lcov - The merged LCOV report.
 * @param expected - The complete executable source inventory.
 * @param root - The repository root used to normalize reported paths.
 * @throws {Error} The report is missing required source files.
 */
export function assertCoverageInventory(
    lcov: string,
    expected: readonly string[],
    root: string
): void {
    const reported = new Set(
        lcov
            .split(/\r?\n/)
            .filter((line) => line.startsWith("SF:"))
            .map((line) =>
                line
                    .slice(3)
                    .replaceAll("\\", "/")
                    .replace(root + "/", "")
                    .replace(/^\.\//, "")
            )
    );
    const missing = expected.filter((file) => !reported.has(file));
    if (missing.length > 0)
        throw new Error("LCOV is missing executable sources:\n" + missing.join("\n"));
    if (expected.length === 0) throw new Error("Coverage source inventory is empty");
}
