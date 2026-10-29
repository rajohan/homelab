import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWindowsCapture } from "./buildWindowsCapture";

/**
 * Prove target-only capture under an independently verified overlapping window in a disposable VM.
 * @param workerDirectory - Optional already qualified package to verify through the real worker.
 * @returns Completion after actual PNG validation, identity/minimize refusals and fixture cleanup.
 */
export async function testWindowsCapture(workerDirectory?: string): Promise<void> {
    if (
        process.platform !== "win32" ||
        process.env.GITHUB_ACTIONS !== "true" ||
        process.env.RUNNER_ENVIRONMENT !== "github-hosted"
    )
        throw new Error(
            "Window capture qualification requires disposable hosted Windows."
        );
    const parent = await realpath(tmpdir());
    const directory = await realpath(
        await mkdtemp(path.join(parent, "mira-window-capture-"))
    );
    if (
        path.dirname(directory) !== parent ||
        !path.basename(directory).startsWith("mira-window-capture-")
    )
        throw new Error("Unexpected capture qualification directory.");
    try {
        await buildWindowsCapture(directory);
        const root = fileURLToPath(new URL("..", import.meta.url));
        const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
        if (!system || !path.isAbsolute(system))
            throw new Error("Windows root is missing.");
        const executable = path.join(directory, "mira-capture-fixture.exe");
        execFileSync(
            path.join(system, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
            [
                "/nologo",
                "/platform:x64",
                "/warnaserror+",
                "/optimize+",
                "/target:winexe",
                `/out:${executable}`,
                `/win32manifest:${path.join(root, "apps/mira/native/windows/app.manifest")}`,
                "/reference:System.Windows.Forms.dll",
                "/reference:System.Drawing.dll",
                "/reference:System.Web.Extensions.dll",
                path.join(root, "apps/mira/native/windows/ConsentProtocol.cs"),
                path.join(root, "apps/mira/native/windows-capture/Fixture.cs"),
            ],
            { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }
        );
        const receipt = execFileSync(
            process.execPath,
            [
                "--no-env-file",
                path.join(root, "apps/mira/src/server/testing/windowsCapture.ts"),
                directory,
                ...(workerDirectory ? [workerDirectory] : []),
            ],
            {
                cwd: root,
                windowsHide: true,
                timeout: 45_000,
                maxBuffer: 64 * 1024,
                encoding: "utf8",
            }
        );
        console.info(receipt.trim());
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
if (import.meta.main) {
    const [directory, ...extra] = process.argv.slice(2);
    if (extra.length > 0 || (directory && !path.isAbsolute(directory)))
        throw new Error("Provide at most one absolute qualified package directory.");
    await testWindowsCapture(directory);
}
