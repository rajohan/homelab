for (const command of ["format:check", "lint", "typecheck"]) {
    const child = Bun.spawn([process.execPath, "run", command], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });
    const result = await child.exited;
    if (result !== 0) {
        process.exit(result);
    }
}

export {};
