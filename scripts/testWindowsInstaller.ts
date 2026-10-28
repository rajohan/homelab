import { execFileSync } from "node:child_process";
import {
    cp,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildComputerInstaller } from "./buildComputerInstaller";
import {
    computerReleaseNames,
    hashComputerFile,
    readComputerRelease,
    verifyComputerPackage,
} from "./computerRelease";

/**
 * Qualify actual per-user install, repair, busy refusal, upgrade and uninstall on disposable Windows CI.
 * @param directory - Previously qualified release archive and manifest from this same CI run.
 * @param compiler - Pinned portable compiler verified by setupInno.ps1.
 * @returns Completion after adding only the successfully tested setup executable to release artifacts.
 */
export async function testWindowsInstaller(
    directory: string,
    compiler: string
): Promise<void> {
    if (
        process.platform !== "win32" ||
        process.env.GITHUB_ACTIONS !== "true" ||
        process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
        process.env.RUNNER_OS !== "Windows"
    )
        throw new Error(
            "Installer qualification requires a disposable GitHub-hosted Windows runner."
        );
    if (!path.isAbsolute(directory) || !path.isAbsolute(compiler))
        throw new Error("Absolute build paths are required.");
    const entries = await readdir(directory);
    const manifests = entries.filter((name) => name.endsWith(".json"));
    if (entries.length !== 2 || manifests.length !== 1)
        throw new Error("Expected one qualified archive and manifest.");
    const manifestPath = path.join(directory, manifests[0]!);
    const release = readComputerRelease(
        JSON.parse(await readFile(manifestPath, "utf8")) as unknown
    );
    const archive = path.join(directory, release.archive.name);
    const digest = await hashComputerFile(archive);
    if (digest.size !== release.archive.size || digest.sha256 !== release.archive.sha256)
        throw new Error("Qualified archive changed.");
    const root = await realpath(
        await mkdtemp(path.join(tmpdir(), "mira-installer-test-"))
    );
    const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!system || !path.isAbsolute(system))
        throw new Error("Windows SystemRoot is required.");
    const powershell = path.join(
        system,
        "System32/WindowsPowerShell/v1.0/powershell.exe"
    );
    try {
        const payload = path.join(root, "payload");
        execFileSync(
            powershell,
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:MIRA_TEST_ARCHIVE,$env:MIRA_TEST_PAYLOAD);",
            ],
            {
                env: {
                    ...process.env,
                    MIRA_TEST_ARCHIVE: archive,
                    MIRA_TEST_PAYLOAD: payload,
                },
                windowsHide: true,
                timeout: 60_000,
            }
        );
        await verifyComputerPackage(payload, release);
        const setup = await buildComputerInstaller({
            directory: payload,
            output: path.join(root, "setup"),
            compiler,
            manifest: release,
        });
        const [major, minor, patch] = release.version.split(".").map(Number);
        const nextVersion = `${major}.${minor}.${patch! + 1}`;
        // Synthetic upgrade metadata tests installer transitions; it is never published.
        const upgrade = await buildComputerInstaller({
            directory: payload,
            output: path.join(root, "upgrade"),
            compiler,
            manifest: {
                ...release,
                version: nextVersion,
                archive: {
                    ...release.archive,
                    name: computerReleaseNames(nextVersion).archive,
                },
            },
        });
        const result = execFileSync(
            powershell,
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-File",
                fileURLToPath(new URL("testWindowsInstaller.ps1", import.meta.url)),
                "-Setup",
                setup.executable,
                "-Upgrade",
                upgrade.executable,
                "-Manifest",
                manifestPath,
                "-UpgradeVersion",
                nextVersion,
                "-Workspace",
                root,
            ],
            {
                windowsHide: true,
                timeout: 300_000,
                maxBuffer: 64 * 1024,
                encoding: "utf8",
            }
        );
        if (!result.includes("Windows installer qualification passed:"))
            throw new Error("Installer qualification did not complete.");
        const finalDigest = await hashComputerFile(setup.executable);
        if (finalDigest.sha256 !== setup.metadata.sha256)
            throw new Error("Tested installer changed.");
        await cp(setup.executable, path.join(directory, setup.metadata.name), {
            force: false,
            errorOnExist: true,
        });
        await writeFile(
            manifestPath,
            JSON.stringify(
                readComputerRelease({ ...release, installer: setup.metadata }),
                null,
                2
            ) + "\n"
        );
        console.info(result.trim());
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
}

if (import.meta.main) {
    const [directory, compiler, ...extra] = process.argv.slice(2);
    if (!directory || !compiler || extra.length > 0)
        throw new Error(
            "Provide the qualified release directory and verified compiler path."
        );
    await testWindowsInstaller(directory, compiler);
}
