import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { version } from "../package.json";
import { buildWindowsComputer } from "./buildWindowsComputer";
import {
    computerReleaseNames,
    hashComputerFile,
    inventoryComputerPackage,
    readComputerRelease,
    verifyComputerPackage,
} from "./computerRelease";

/**
 * Build a complete Windows ZIP and verify its own round-trip extraction before native qualification.
 * @param root - Fresh, absolute caller-owned build directory; output is never overwritten.
 * @param revision - Exact checked-out Git commit recorded in passive release metadata.
 * @returns Archive/manifest paths and the extracted package to qualify; nothing is installed or started.
 */
export async function buildComputerDistribution(root: string, revision: string) {
    if (
        process.platform !== "win32" ||
        !path.isAbsolute(root) ||
        !/^[a-f0-9]{40}$/.test(revision)
    )
        throw new Error(
            "Windows distribution requires an absolute build root and exact source revision."
        );
    const bunVersionFile = await readFile(
        new URL("../.bun-version", import.meta.url),
        "utf8"
    );
    const pinnedBun = bunVersionFile.trim();
    if (Bun.version !== pinnedBun)
        throw new Error("Build the computer package with the pinned Bun version.");
    const { directory } = await buildWindowsComputer(path.join(root, "payload"));
    const files = await inventoryComputerPackage(directory);
    const output = path.join(root, "release");
    await mkdir(output);
    const names = computerReleaseNames(version);
    const archive = path.join(output, names.archive);
    const extracted = path.join(root, "extracted");
    const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
            ["SYSTEMROOT", "TEMP", "TMP"].includes(key.toUpperCase())
        )
    );
    const system = environment.SystemRoot ?? environment.SYSTEMROOT;
    if (!system || !path.isAbsolute(system))
        throw new Error("Windows SystemRoot is required.");
    // Only archive this build's own fresh tree. This is not an untrusted ZIP installer.
    const powershell = path.join(
        system,
        "System32/WindowsPowerShell/v1.0/powershell.exe"
    );
    execFileSync(
        powershell,
        [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
                "[System.IO.Compression.ZipFile]::CreateFromDirectory($env:MIRA_PACKAGE_SOURCE,$env:MIRA_PACKAGE_ARCHIVE); " +
                "[System.IO.Compression.ZipFile]::ExtractToDirectory($env:MIRA_PACKAGE_ARCHIVE,$env:MIRA_PACKAGE_EXTRACTED);",
        ],
        {
            cwd: system,
            env: {
                ...environment,
                MIRA_PACKAGE_SOURCE: directory,
                MIRA_PACKAGE_ARCHIVE: archive,
                MIRA_PACKAGE_EXTRACTED: extracted,
            },
            windowsHide: true,
            timeout: 120_000,
            maxBuffer: 64 * 1024,
        }
    );
    const application = JSON.parse(
        await readFile(new URL("../apps/mira/package.json", import.meta.url), "utf8")
    ) as { dependencies: Record<string, string> };
    const manifest = readComputerRelease({
        schemaVersion: 1,
        platform: "windows-x64",
        version,
        revision,
        bun: Bun.version,
        driver: application.dependencies["@trycua/cua-driver"],
        archive: { name: names.archive, ...(await hashComputerFile(archive)) },
        files,
    });
    await verifyComputerPackage(directory, manifest);
    await verifyComputerPackage(extracted, manifest);
    const manifestPath = path.join(output, names.manifest);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
        flag: "wx",
    });
    return {
        archive,
        manifest: manifestPath,
        directory: await realpath(extracted),
        metadata: manifest,
    };
}
