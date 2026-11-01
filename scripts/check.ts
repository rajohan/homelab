/**
 * Check formatting, lint and TypeScript without changing source files.
 * @returns Completion after checks finish; the first failing status is preserved.
 */
export async function main(): Promise<void> {
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
