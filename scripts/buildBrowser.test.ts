import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildBrowser } from "./buildBrowser";

const linux = process.platform === "linux" && process.arch === "x64";
test.skipIf(!linux)(
    "browser package contains only the runnable worker and pinned official CLI",
    async () => {
        const output = await mkdtemp(path.join(os.tmpdir(), "browser-build-test-"));
        try {
            await buildBrowser(output, (file) =>
                writeFile(file, "synthetic executable for bundle layout only")
            );
            const entries = await readdir(output);
            expect(entries.toSorted()).toEqual([
                "cua-driver",
                "package.json",
                "worker.js",
            ]);
            const worker = Bun.spawn(
                [process.execPath, "--no-env-file", path.join(output, "worker.js")],
                { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 5000 }
            );
            await worker.stdin.end();
            expect(await worker.exited).toBe(0);
            expect(await new Response(worker.stdout).text()).toBe("");
            expect(await new Response(worker.stderr).text()).toBe("");
            await assert.rejects(buildBrowser(output), /must be empty/);
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    },
    20_000
);
test("browser package refuses relative output", async () => {
    await assert.rejects(
        buildBrowser("relative-output"),
        /Linux x64 and absolute output/
    );
});
