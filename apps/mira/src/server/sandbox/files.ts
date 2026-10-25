import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Create a fresh directory below an already validated root without following an existing link.
 * @param root - Canonical sandbox root.
 * @param name - Single fixed directory basename.
 * @returns Canonical newly created directory; existing paths fail instead of being removed.
 */
export async function createSandboxDirectory(
    root: string,
    name: string
): Promise<string> {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || (await realpath(root)) !== root)
        throw new Error("Invalid sandbox directory.");
    const destination = path.join(root, name);
    await mkdir(destination, { mode: 0o700 });
    if ((await realpath(destination)) !== destination)
        throw new Error("Sandbox path changed.");
    return destination;
}
/**
 * Read one explicitly selected regular input without following a final symlink or buffering an unbounded file.
 * @param filename - Fixed path inside the validated input directory.
 * @param expectedHash - Exact human-approved digest.
 * @returns At most one MiB of matching bytes.
 */
export async function readSandboxPatch(
    filename: string,
    expectedHash: string
): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("Invalid patch digest.");
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > 1_048_576)
            throw new Error("Patch must be a regular file up to 1 MiB.");
        const buffer = Buffer.alloc(1_048_577);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await file.read(
                buffer,
                length,
                buffer.length - length,
                null
            );
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        const bytes = buffer.subarray(0, length);
        if (
            length > 1_048_576 ||
            new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== expectedHash
        )
            throw new Error("Patch no longer matches the reviewed bytes.");
        return bytes;
    } finally {
        await file.close();
    }
}
/**
 * Save a bounded passive artifact using a fresh non-symlink file.
 * @param directory - Canonical output directory.
 * @param name - Fixed output basename.
 * @param text - UTF-8 artifact, capped at one MiB.
 * @returns Completion after the file is closed.
 */
export async function writeSandboxArtifact(
    directory: string,
    name: string,
    text: string
): Promise<void> {
    if (
        !/^[a-z-]+\.(?:json|txt)$/.test(name) ||
        Buffer.byteLength(text) > 1_048_576 ||
        (await realpath(directory)) !== directory
    )
        throw new Error("Invalid sandbox artifact.");
    const file = await open(
        path.join(directory, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
    );
    try {
        await file.writeFile(text);
    } finally {
        await file.close();
    }
}
