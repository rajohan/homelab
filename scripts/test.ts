import { testArguments } from "./testing/command";
import { discoverTests, type TestGroup } from "./testing/inventory";

/**
 * Run complete test partitions, keeping DOM emulation out of real HTTP tests.
 * @returns Completion after the selected tests; preserves the first failing exit code.
 */
export async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "integration" && arg !== "--coverage"))
        throw new Error("Usage: bun run test [integration] [--coverage]");
    const coverage = args.includes("--coverage");
    const inventory = discoverTests();
    const groups: TestGroup[] = args.includes("integration")
        ? ["integration"]
        : ["unit", "component"];
    for (const group of groups) {
        const report = Bun.file(`coverage/${group}/lcov.info`);
        if (coverage && (await report.exists())) await report.delete();
        const child = Bun.spawn(
            [process.execPath, ...testArguments(group, inventory[group], coverage)],
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
            return;
        }
        if (coverage && !(await report.exists()))
            throw new Error(`The ${group} coverage report was not generated.`);
    }
}
if (import.meta.main) await main();
