import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import manifest from "./systemSkills.json";

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
            const entryStat = await lstat(file);
            if (!prefix && entry.name === ".codex-system-skills.marker") {
                if (!entry.isFile() || entryStat.size > 128)
                    throw new Error("Invalid Mira system skills marker.");
                continue;
            }
            const key = name + (entry.isDirectory() ? "/" : "");
            if (!(key in expected))
                throw new Error("Mira runtime contains unrecognized system skills.");
            seen.add(key);
            if (entry.isDirectory() && expected[key] === null) await visit(file, key);
            else if (entry.isFile() && entryStat.size <= 1_000_000) {
                const digest = new Bun.CryptoHasher("sha256")
                    .update(await readFile(file))
                    .digest("hex");
                if (digest !== expected[key])
                    throw new Error("Mira runtime contains modified system skills.");
            } else throw new Error("Mira system skills contain an unsupported entry.");
        }
    };
    await visit(system, "");
    if (seen.size !== Object.keys(expected).length)
        throw new Error("Mira system skills cache is incomplete.");
}
