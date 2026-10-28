import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

const maximumBytes = 512 * 1024 * 1024;
const versionSchema = v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/));
const digestSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const sizeSchema = v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(maximumBytes)
);
const fileSchema = v.strictObject({
    path: v.string(),
    size: sizeSchema,
    sha256: digestSchema,
});
const releaseSchema = v.strictObject({
    schemaVersion: v.literal(1),
    platform: v.literal("windows-x64"),
    version: versionSchema,
    revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
    bun: versionSchema,
    driver: versionSchema,
    archive: v.strictObject({ name: v.string(), size: sizeSchema, sha256: digestSchema }),
    files: v.pipe(v.array(fileSchema), v.minLength(5), v.maxLength(2048)),
});

export type ComputerReleaseFile = v.InferOutput<typeof fileSchema>;
export type ComputerRelease = v.InferOutput<typeof releaseSchema>;

/**
 * Select fixed versioned release filenames without accepting paths or prerelease labels.
 * @param version - Stable repository release version.
 * @returns Archive and passive manifest asset names.
 */
export function computerReleaseNames(version: string) {
    v.parse(versionSchema, version);
    const stem = `mira-computer-${version}-windows-x64`;
    return { archive: `${stem}.zip`, manifest: `${stem}.json` };
}

function assertRelativeFile(name: string) {
    if (
        name.length > 240 ||
        name
            .split("/")
            .some(
                (part) =>
                    !/^[a-zA-Z0-9@._-]+$/.test(part) ||
                    part === "." ||
                    part === ".." ||
                    part.endsWith(".") ||
                    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
            )
    )
        throw new Error("Invalid Windows package file name.");
}

/**
 * Validate a bounded passive release manifest, including Windows path aliases and required entrypoints.
 * @param input - Parsed JSON from a trusted build or separately authenticated release source.
 * @returns The checked manifest; hashes alone do not authenticate a publisher.
 */
export function readComputerRelease(input: unknown): ComputerRelease {
    const release = v.parse(releaseSchema, input);
    if (
        release.archive.name !== computerReleaseNames(release.version).archive ||
        release.archive.size === 0
    )
        throw new Error("Invalid Windows archive identity.");
    const names = new Set<string>();
    let total = 0;
    for (const file of release.files) {
        assertRelativeFile(file.path);
        const name = file.path.toLowerCase();
        if (names.has(name)) throw new Error("Duplicate Windows package file.");
        names.add(name);
        total += file.size;
    }
    for (const name of names) {
        const parts = name.split("/");
        while (parts.length > 1) {
            parts.pop();
            if (names.has(parts.join("/")))
                throw new Error("Conflicting Windows package paths.");
        }
    }
    if (
        total > maximumBytes ||
        ![
            "mira-computer-desktop.exe",
            "mira-computer.exe",
            "mira-computer-consent.exe",
            "mira-computer-worker-host.exe",
            "mira-computer-worker.exe",
        ].every((name) =>
            release.files.some((file) => file.path === name && file.size > 0)
        )
    )
        throw new Error("Incomplete or oversized Windows package.");
    return release;
}

/**
 * Hash one ordinary, bounded file using a stream and reject changes during the read.
 * @param file - Local build output; links and special files are not accepted.
 * @returns Exact length and SHA-256 digest.
 */
export async function hashComputerFile(file: string) {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes)
        throw new Error("Invalid computer release file.");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(file)) {
        if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected file stream chunk.");
        size += chunk.length;
        if (size > maximumBytes) throw new Error("Computer release file is too large.");
        hash.update(chunk);
    }
    const after = await lstat(file);
    if (
        size !== before.size ||
        after.size !== size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino
    )
        throw new Error("Computer release changed during hashing.");
    return { size, sha256: hash.digest("hex") };
}

/**
 * Inventory a caller-owned build tree without following symbolic links.
 * @param directory - Absolute package directory produced in a fresh build workspace.
 * @returns Sorted file hashes for round-trip extraction verification.
 */
export async function inventoryComputerPackage(
    directory: string
): Promise<ComputerReleaseFile[]> {
    if (!path.isAbsolute(directory))
        throw new Error("Computer package path must be absolute.");
    const files: ComputerReleaseFile[] = [];
    let total = 0;
    async function visit(relative: string): Promise<void> {
        const current = path.join(directory, relative);
        const metadata = await lstat(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
            throw new Error("Invalid package directory.");
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            assertRelativeFile(name);
            if (entry.isDirectory()) await visit(name);
            else if (entry.isFile()) {
                if (files.length >= 2048)
                    throw new Error("Too many computer package files.");
                const content = await hashComputerFile(path.join(directory, name));
                total += content.size;
                if (total > maximumBytes)
                    throw new Error("Computer package is too large.");
                files.push({ path: name, ...content });
            } else
                throw new Error(
                    "Computer package links and special files are not allowed."
                );
        }
    }
    await visit("");
    return files.toSorted((left, right) => left.path.localeCompare(right.path, "en"));
}

/**
 * Compare an unpacked, caller-owned build against the original manifest before running qualification.
 * @param directory - Fresh extraction directory, never a running installation.
 * @param manifest - Already parsed release metadata, checked again before comparison.
 * @returns Completion only when every file, length and digest matches with no extras.
 */
export async function verifyComputerPackage(
    directory: string,
    manifest: unknown
): Promise<void> {
    const expected = readComputerRelease(manifest).files.toSorted((left, right) =>
        left.path.localeCompare(right.path, "en")
    );
    const actual = await inventoryComputerPackage(directory);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error("Computer package does not match its manifest.");
}
