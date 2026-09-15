import { mergeCoverageReportFiles } from "lcov-result-merger";

import { assertCoverageInventory, executableSources } from "./coverageInventory";

/**
 * Merge coverage partitions and verify every executable source appears in the report.
 * @returns Completion after the complete merged report is written.
 */
export async function checkCoverage(): Promise<void> {
    const paths = ["unit", "component", "integration"].map(
        (group) => `coverage/${group}/lcov.info`
    );
    for (const path of paths)
        if (!(await Bun.file(path).exists()))
            throw new Error("Missing coverage partition: " + path);
    const lcov = await mergeCoverageReportFiles(paths, {
        pattern: "coverage/*/lcov.info",
    });
    const sources = await executableSources();
    assertCoverageInventory(lcov, sources, process.cwd());
    await Bun.write("coverage/lcov.info", lcov);
    const records = lcov
        .split("end_of_record")
        .filter((record) =>
            sources.some(
                (source) =>
                    record.includes("SF:" + source + "\n") ||
                    record.includes("SF:" + process.cwd() + "/" + source + "\n")
            )
        );
    const found = records.reduce(
        (sum, record) => sum + Number(/^LF:(\d+)$/m.exec(record)?.[1] ?? 0),
        0
    );
    const hit = records.reduce(
        (sum, record) => sum + Number(/^LH:(\d+)$/m.exec(record)?.[1] ?? 0),
        0
    );
    if (!found) throw new Error("Coverage contains no executable lines");
    console.info(
        `Complete source inventory: ${sources.length} files; line coverage ${((100 * hit) / found).toFixed(2)}% (${hit}/${found}).`
    );
}
if (import.meta.main) await checkCoverage();
