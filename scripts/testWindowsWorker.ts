import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildComputerDistribution } from "./buildComputerDistribution";
import { buildWindowsWorkerHost } from "./buildWindowsWorkerHost";
import { hashComputerFile, verifyComputerPackage } from "./computerRelease";

/**
 * Qualify Windows process ownership and SDK loading, plus native input on disposable hosted runners.
 * @param exportDirectory - Optional empty absolute directory receiving only successfully qualified release files.
 * @returns Completion after process cleanup, package validation and any required hosted native qualification.
 */
export async function testWindowsWorker(exportDirectory?: string): Promise<void> {
    if (exportDirectory) {
        if (!path.isAbsolute(exportDirectory))
            throw new Error("Release export must be absolute.");
        await mkdir(exportDirectory, { recursive: true });
        const exported = await readdir(exportDirectory);
        if (exported.length > 0) throw new Error("Release export must be empty.");
    }
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
        const sourceRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
        const revision = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: sourceRoot,
            encoding: "utf8",
            windowsHide: true,
        }).trim();
        const release = await buildComputerDistribution(root, revision);
        execFileSync(
            process.execPath,
            [
                "--no-env-file",
                path.join(sourceRoot, "apps/mira/src/server/testing/windowsWorker.ts"),
                release.directory,
                root,
                tests.checks!,
            ],
            {
                cwd: sourceRoot,
                windowsHide: true,
                timeout: 60_000,
                maxBuffer: 64 * 1024,
                stdio: "pipe",
            }
        );
        if (process.env.GITHUB_ACTIONS === "true") {
            const receipt = execFileSync(
                process.execPath,
                [
                    "--no-env-file",
                    path.join(sourceRoot, "apps/mira/src/server/testing/windowsInput.ts"),
                    release.directory,
                    root,
                ],
                {
                    cwd: sourceRoot,
                    windowsHide: true,
                    timeout: 90_000,
                    maxBuffer: 64 * 1024,
                    encoding: "utf8",
                }
            );
            console.info(receipt.trim());
        }
        await verifyComputerPackage(release.directory, release.metadata);
        const digest = await hashComputerFile(release.archive);
        if (
            digest.sha256 !== release.metadata.archive.sha256 ||
            digest.size !== release.metadata.archive.size
        )
            throw new Error("Qualified archive changed.");
        if (exportDirectory) {
            for (const file of [release.archive, release.manifest])
                await cp(file, path.join(exportDirectory, path.basename(file)), {
                    force: false,
                    errorOnExist: true,
                });
        }
        console.info(result.trim());
        console.info(
            "Windows release ZIP: exact inventory, extracted companion, SDK metadata, both N-API addons, isolated startup, confirmed cleanup and missing-library refusals passed."
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
if (import.meta.main) {
    const [directory, ...extra] = process.argv.slice(2);
    if (extra.length > 0)
        throw new Error("Provide at most one absolute release export directory.");
    await testWindowsWorker(directory);
}
