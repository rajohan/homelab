import { lstat, opendir, realpath, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Remove abandoned private image copies after the maximum execution lifetime has passed.
 * @param home - Canonical dedicated Mira profile; never a shared client home.
 * @param now - Cleanup clock for deterministic recovery checks.
 * @returns Number of old owned directories removed; active and unrelated entries remain untouched.
 */
export async function cleanupMiraScratch(
    home: string,
    now = Date.now()
): Promise<number> {
    const parent = path.join(home, "message-files");
    let directory;
    try {
        if ((await realpath(parent)) !== parent)
            throw new Error("Mira scratch directory must not be a link.");
        directory = await opendir(parent);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return 0;
        throw error;
    }
    let removed = 0;
    for await (const entry of directory) {
        if (removed >= 20) break;
        if (!/^turn-[a-zA-Z0-9]{6}$/.test(entry.name) || !entry.isDirectory()) continue;
        const target = path.join(parent, entry.name);
        const metadata = await lstat(target);
        if (
            !metadata.isDirectory() ||
            metadata.isSymbolicLink() ||
            metadata.mtimeMs >= now - 86_400_000
        )
            continue;
        await rm(target, { recursive: true, force: true });
        removed++;
    }
    return removed;
}
