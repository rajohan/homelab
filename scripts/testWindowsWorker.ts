import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWindowsWorker } from "./buildWindowsWorker";
import { buildWindowsWorkerHost } from "./buildWindowsWorkerHost";

/**
 * Qualify real Windows process ownership and packaged SDK loading without capture or input.
 * @returns Completion after child/grandchild exit tests, native metadata and actual port startup/close.
 */
export async function testWindowsWorker(): Promise<void> {
    const root = await realpath(
        await mkdtemp(path.join(tmpdir(), "mira-windows-worker-"))
    );
    if (
        path.dirname(root) !== (await realpath(tmpdir())) ||
        !path.basename(root).startsWith("mira-windows-worker-")
    )
        throw new Error("Unexpected worker qualification directory.");
    try {
        const tests = await buildWindowsWorkerHost(path.join(root, "native"), true);
        const result = execFileSync(tests.checks!, [tests.fixtureHost!], {
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: 64 * 1024,
            encoding: "utf8",
        });
        if (!result.includes("23 assertions passed"))
            throw new Error("Worker ownership qualification failed.");
        const directory = path.join(root, "package");
        await buildWindowsWorker(directory);
        const sourceRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
        execFileSync(
            process.execPath,
            [
                "--no-env-file",
                path.join(sourceRoot, "apps/mira/src/server/testing/windowsWorker.ts"),
                directory,
                root,
            ],
            {
                cwd: sourceRoot,
                windowsHide: true,
                timeout: 60_000,
                maxBuffer: 64 * 1024,
                stdio: "pipe",
            }
        );
        console.info(result.trim());
        console.info(
            "Packaged Windows worker: SDK metadata, both N-API addons, isolated startup, confirmed cleanup and missing-library refusals passed."
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
if (import.meta.main) await testWindowsWorker();
