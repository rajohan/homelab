import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { dependencies } from "../../../../../package.json";

export type SystemSkills = Readonly<Record<string, string | null>>;

/** Read the skill fingerprints generated beside the packaged native executable.
 * @param command - Trusted configured Codex executable.
 * @returns The fingerprints extracted from the same locked package at build time.
 */
export async function readSystemSkills(command: string): Promise<SystemSkills> {
    const manifest = v.parse(
        v.object({
            version: v.literal(dependencies["@openai/codex"]),
            entries: v.record(
                v.string(),
                v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)))
            ),
        }),
        JSON.parse(
            await readFile(path.join(path.dirname(command), "system-skills.json"), "utf8")
        )
    );
    if (Object.keys(manifest.entries).length === 0)
        throw new Error("The packaged Codex system skills are missing.");
    return manifest.entries;
}

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

/** Reject custom skills before the native runtime refreshes its own generated cache.
 * @param codexHome - Explicit Mira profile directory.
 * @returns System cache path, or null when the native runtime has not created it yet.
 */
export async function assertNoCustomSkills(codexHome: string): Promise<string | null> {
    const root = path.join(codexHome, "skills");
    let stat;
    try {
        stat = await lstat(root);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Mira skills directory must not be a link.");
    const entries = await readdir(root);
    if (entries.some((entry) => entry !== ".system"))
        throw new Error("Mira runtime home contains custom skills.");
    if (entries.length === 0) return null;
    const system = path.join(root, ".system");
    const systemStat = await lstat(system);
    if (!systemStat.isDirectory() || systemStat.isSymbolicLink())
        throw new Error("Mira system skills must not contain links.");
    return system;
}

/** Verify cached skills against fingerprints extracted from the packaged executable.
 * @param codexHome - Explicit Mira profile directory, never a browser-supplied path.
 * @param expected - Build-generated fingerprints from the locked native package.
 * @returns Completion when the cache is absent or matches the installed runtime.
 */
export async function assertSystemSkills(
    codexHome: string,
    expected: SystemSkills
): Promise<void> {
    const system = await assertNoCustomSkills(codexHome);
    if (!system) return;
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
