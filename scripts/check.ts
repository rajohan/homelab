import { checkTimings } from "./testing/inventory";

/**
 * Require complete test timings, formatting, lint and TypeScript checks.
 * @returns Completion after checks finish; the first failing status is preserved.
 */
export async function main(): Promise<void> {
    await checkTimings();
    for (const command of ["format:check", "lint", "typecheck"]) {
        const child = Bun.spawn([process.execPath, "run", command], {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        });
        const result = await child.exited;
        if (result !== 0) {
            process.exitCode = result;
            break;
        }
    }
}

if (import.meta.main) await main();
