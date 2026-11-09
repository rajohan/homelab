import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyBun } from "./verifyBun";

test("the bootstrap rejects musl before downloading a glibc executable", () => {
    const child = Bun.spawnSync(
        [
            process.execPath,
            "--no-env-file",
            "-e",
            `import { installBun } from "./scripts/installBun.ts";
            Object.defineProperty(process, "platform", { value: "linux" });
            process.report.getReport = () => ({ header: {} });
            Bun.spawnSync = () => { throw new Error("Unexpected download"); };
            await installBun(process.cwd());`,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 10_000, windowsHide: true }
    );
    expect(child.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toContain(
        "requires glibc; musl is not supported"
    );
});

test("the pinned runtime and its compiled native executable use the same revision", async () => {
    await verifyBun();
    const directory = await mkdtemp(path.join(tmpdir(), "homelab-bun-runtime-"));
    try {
        const source = path.join(directory, "revision.ts");
        const output = path.join(
            directory,
            process.platform === "win32" ? "revision.exe" : "revision"
        );
        await writeFile(source, "process.stdout.write(Bun.revision);");
        const build = Bun.spawnSync(
            [
                process.execPath,
                "build",
                "--compile",
                `--compile-executable-path=${process.execPath}`,
                `--outfile=${output}`,
                source,
            ],
            { stdout: "pipe", stderr: "pipe", timeout: 30_000, windowsHide: true }
        );
        expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
        const run = Bun.spawnSync([output], {
            stdout: "pipe",
            stderr: "pipe",
            timeout: 10_000,
            windowsHide: true,
        });
        expect(run.exitCode).toBe(0);
        expect(new TextDecoder().decode(run.stdout)).toBe(Bun.revision);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 45_000);
