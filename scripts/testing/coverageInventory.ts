export async function executableSources(): Promise<string[]> {
    const files = [
        ...new Bun.Glob("{apps,packages,scripts}/**/*.{ts,tsx}").scanSync("."),
        ...new Bun.Glob("*.config.ts").scanSync("."),
    ]
        .filter(
            (file) =>
                !/(?:^|\/)(?:node_modules|dist|tests)\//.test(file) &&
                !file.includes("/server/testing/") &&
                !/\.(?:test|spec)\.|\.d\.ts$/.test(file)
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
