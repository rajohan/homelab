import { unlink } from "node:fs/promises";

import { testArguments } from "./testing/command";
import {
    assertTimings,
    discoverTests,
    timingFiles,
    type TestGroup,
} from "./testing/inventory";

export async function main(): Promise<void> {
    const mode = process.argv[2];
    const allowed = [
        "coverage",
        "integration",
        "integration-coverage",
        "timings",
        "integration-timings",
    ];
    if (process.argv.length > 3 || (mode && !allowed.includes(mode)))
        throw new Error(
            "Use the documented test scripts; arbitrary runner overrides are not allowed."
        );
    const integration = mode?.startsWith("integration") ?? false;
    const coverage = mode?.endsWith("coverage") ?? false;
    const update = mode?.endsWith("timings") ?? false;
    const inventory = discoverTests();
    const groups: TestGroup[] = integration ? ["integration"] : ["unit", "component"];
    for (const group of groups) {
        const files = inventory[group];
        const target = timingFiles[group];
        const staged = update ? `${target}.${crypto.randomUUID()}.tmp` : target;
        try {
            if (update) {
                await Bun.write(staged, JSON.stringify({ version: 1, files: {} }));
            } else {
                assertTimings(await Bun.file(target).json(), files, group);
            }
            if (coverage) {
                const report = Bun.file(`coverage/${group}/lcov.info`);
                if (await report.exists()) await report.delete();
            }
            const child = Bun.spawn(
                [
                    process.execPath,
                    ...testArguments(group, files, coverage, staged, update),
                ],
                {
                    stdin: "inherit",
                    stdout: "inherit",
                    stderr: "inherit",
                    env: { ...process.env, HOMELAB_COVERAGE_GROUP: group },
                }
            );
            const result = await child.exited;
            if (result !== 0) {
                process.exitCode = result;
                break;
            }
            if (update) {
                const measured = assertTimings(
                    await Bun.file(staged).json(),
                    files,
                    group
                );
                await Bun.write(target, JSON.stringify(measured, null, 4) + "\n");
            }
            if (coverage && !(await Bun.file(`coverage/${group}/lcov.info`).exists()))
                throw new Error(`The ${group} coverage report was not generated.`);
        } finally {
            if (update) await unlink(staged);
        }
    }
}

if (import.meta.main) await main();
