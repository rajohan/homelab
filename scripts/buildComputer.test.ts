import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { version } from "../package.json";
import { buildComputer } from "./buildComputer";

test("compiled companion runs independently and ignores ambient bunfig preload and dotenv", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-companion-build-"));
    try {
        const executable = await buildComputer("linux-x64", directory);
        await writeFile(
            path.join(directory, "bunfig.toml"),
            'preload = ["./untrusted.ts"]\n'
        );
        await writeFile(
            path.join(directory, "untrusted.ts"),
            'throw new Error("Ambient preload executed");\n'
        );
        await writeFile(
            path.join(directory, ".env"),
            "BUN_OPTIONS=--preload ./untrusted.ts\n"
        );
        for (const argument of ["--version", "--help"]) {
            const child = Bun.spawn([executable, argument], {
                cwd: directory,
                env: { PATH: "/usr/bin:/bin" },
                stdout: "pipe",
                stderr: "pipe",
            });
            const [out, err, code] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);
            expect(code).toBe(0);
            expect(err).toBe("");
            expect(out).toContain(version);
            if (argument === "--help")
                expect(out).toContain("does not allow screen or input access");
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 30_000);
