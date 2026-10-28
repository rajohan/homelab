import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    computerReleaseNames,
    hashComputerFile,
    inventoryComputerPackage,
    readComputerRelease,
    verifyComputerPackage,
    type ComputerReleaseFile,
    type ComputerRelease,
} from "./computerRelease";

const entrypoints = [
    "mira-computer-desktop.exe",
    "mira-computer.exe",
    "mira-computer-consent.exe",
    "mira-computer-worker-host.exe",
    "mira-computer-worker.exe",
];
function manifest(
    files = entrypoints.map((name) => ({ path: name, size: 1, sha256: "a".repeat(64) }))
): ComputerRelease {
    return {
        schemaVersion: 1,
        platform: "windows-x64",
        version: "0.10.0",
        revision: "a".repeat(40),
        bun: "1.4.4",
        driver: "0.37.0",
        archive: {
            name: "mira-computer-0.10.0-windows-x64.zip",
            size: 100,
            sha256: "b".repeat(64),
        },
        files,
    };
}

test("release metadata binds stable version, source, platform, bounded archive and complete entrypoints", () => {
    const release = manifest();
    expect(readComputerRelease(release)).toEqual(release);
    expect(computerReleaseNames("0.10.0").manifest).toBe(
        "mira-computer-0.10.0-windows-x64.json"
    );
    for (const version of ["../0.10.0", "0.10.0-rc.1", "v0.10.0", "0.10.0/else"])
        expect(() => computerReleaseNames(version)).toThrow();
    for (const changed of [
        { revision: "main" },
        { platform: "windows-arm64" },
        { bun: "latest" },
        { credential: "forbidden" },
        { archive: { ...release.archive, name: "../test.zip" } },
        { archive: { ...release.archive, size: 0 } },
        { archive: { ...release.archive, sha256: "no" } },
        { archive: { ...release.archive, size: 513 * 1024 * 1024 } },
        { files: release.files.slice(1) },
        { files: [...release.files, ...release.files] },
        { files: release.files.map((file) => ({ ...file, size: 200 * 1024 * 1024 })) },
        { files: release.files.map((file) => ({ ...file, size: 0 })) },
    ])
        expect(() => readComputerRelease({ ...release, ...changed })).toThrow();
});

test("manifest rejects Windows aliases, traversal, streams, reserved names and file-directory conflicts", () => {
    for (const name of [
        "../a",
        "/a",
        String.raw`a\b`,
        "C:/a",
        "a:b",
        "a/./b",
        "a//b",
        "a/CON.txt",
        "aux",
        "COM1.bin",
        "a.",
        "a ",
        "a\u0000b",
        "a".repeat(241),
        "MIRA-COMPUTER.EXE",
        "mira-computer.exe/child",
    ]) {
        expect(() =>
            readComputerRelease(
                manifest([
                    ...manifest().files,
                    { path: name, size: 1, sha256: "c".repeat(64) },
                ])
            )
        ).toThrow();
    }
    expect(() =>
        readComputerRelease(
            manifest([
                ...manifest().files,
                ...Array.from({ length: 2048 }, (_, index) => ({
                    path: `node_modules/${index}.js`,
                    size: 1,
                    sha256: "c".repeat(64),
                })),
            ])
        )
    ).toThrow();
});

test("real package inventory detects modified, missing, extra and linked files before qualification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mira-release-test-"));
    if (
        path.dirname(root) !== tmpdir() ||
        !path.basename(root).startsWith("mira-release-test-")
    )
        throw new Error("Unexpected test root.");
    try {
        for (const name of entrypoints) await writeFile(path.join(root, name), name);
        await mkdir(path.join(root, "node_modules", "sdk"), { recursive: true });
        const library = path.join(root, "node_modules", "sdk", "index.js");
        await writeFile(library, "original");
        const files: ComputerReleaseFile[] = await inventoryComputerPackage(root);
        const release = manifest(files);
        await verifyComputerPackage(root, release);
        expect(await hashComputerFile(library)).toEqual({
            size: 8,
            sha256: "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5",
        });
        await writeFile(library, "modified");
        await rejects(verifyComputerPackage(root, release), /does not match/);
        await writeFile(library, "original");
        await rename(library, library + ".extra");
        await rejects(verifyComputerPackage(root, release), /does not match/);
        await rename(library + ".extra", library);
        await writeFile(path.join(root, "extra.txt"), "extra");
        await rejects(verifyComputerPackage(root, release), /does not match/);
        await rm(path.join(root, "extra.txt"));
        if (process.platform !== "win32") {
            const link = path.join(root, "linked");
            await symlink(library, link);
            await rejects(inventoryComputerPackage(root), /links/);
            await rejects(hashComputerFile(link), /Invalid/);
            await rm(link);
            await symlink(path.join(root, "node_modules"), link, "dir");
            await rejects(inventoryComputerPackage(root), /links/);
            await rm(link);
        }
        await rejects(inventoryComputerPackage("relative"), /absolute/);
        await rejects(hashComputerFile(root), /Invalid/);
        await verifyComputerPackage(root, release);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
