import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

import manifest from "./systemSkills.json";

async function skillDigest(file: string, maximum: number): Promise<string> {
    // Inspect and read the same opened object. Never reopen a pathname after checking it.
    const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maximum)
            throw new Error("Invalid Mira system skills file.");
        const contents = Buffer.alloc(maximum + 1);
        let length = 0;
        while (length < contents.length) {
            const { bytesRead } = await handle.read(
                contents,
                length,
                contents.length - length,
                length
            );
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        if (length !== stat.size || length > maximum)
            throw new Error("Mira system skills changed while being verified.");
        return new Bun.CryptoHasher("sha256")
            .update(contents.subarray(0, length))
            .digest("hex");
    } finally {
        await handle.close();
    }
}

/**
 * Reject custom or modified cached skills using the pinned upstream bundle manifest.
 * @param codexHome - Explicit Mira profile directory, never a browser-supplied path.
 * @returns Completion when the cache is absent or exactly matches the supported version.
 */
export async function assertSystemSkills(codexHome: string): Promise<void> {
    const root = path.join(codexHome, "skills");
    let stat;
    try {
        stat = await lstat(root);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Mira skills directory must not be a link.");
    const entries = await readdir(root);
    if (entries.some((entry) => entry !== ".system"))
        throw new Error("Mira runtime home contains custom skills.");
    if (entries.length === 0) return;
    const system = path.join(root, ".system");
    const expected: Readonly<Record<string, string | null>> = manifest.entries;
    const seen = new Set<string>();
    const visit = async (directory: string, prefix: string): Promise<void> => {
        const directoryStat = await lstat(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
            throw new Error("Mira system skills must not contain links.");
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const name = prefix + entry.name;
            const file = path.join(directory, entry.name);
            if (!prefix && entry.name === ".codex-system-skills.marker") {
                if (!entry.isFile())
                    throw new Error("Invalid Mira system skills marker.");
                await skillDigest(file, 128);
                continue;
            }
            const key = name + (entry.isDirectory() ? "/" : "");
            if (!(key in expected))
                throw new Error("Mira runtime contains unrecognized system skills.");
            seen.add(key);
            if (entry.isDirectory() && expected[key] === null) await visit(file, key);
            else if (entry.isFile()) {
                const digest = await skillDigest(file, 1_000_000);
                if (digest !== expected[key])
                    throw new Error("Mira runtime contains modified system skills.");
            } else throw new Error("Mira system skills contain an unsupported entry.");
        }
    };
    await visit(system, "");
    if (seen.size !== Object.keys(expected).length)
        throw new Error("Mira system skills cache is incomplete.");
}
