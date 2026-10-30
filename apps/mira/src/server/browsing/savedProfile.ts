import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { browserProfileDirectory } from "./profile";

/**
 * Prepare the fixed, exclusively mounted profile before any Chromium process starts.
 * @param directory - Trusted fixed volume root; an isolated temporary path is used by tests only.
 * @returns Completion after removing only stale Chromium runtime links and its old port marker.
 */
export async function prepareSavedBrowserProfile(
    directory = browserProfileDirectory
): Promise<void> {
    const root = await lstat(directory);
    if (
        !path.isAbsolute(directory) ||
        !root.isDirectory() ||
        (await realpath(directory)) !== directory ||
        root.uid !== process.getuid?.() ||
        (root.mode & 0o777) !== 0o700
    )
        throw new Error("Invalid saved browser profile storage.");
    const selected = path.join(directory, "saved");
    const profile = await lstat(selected).catch((error: unknown) => {
        if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return null;
        throw error;
    });
    if (!profile) return;
    if (
        !profile.isDirectory() ||
        (await realpath(selected)) !== selected ||
        profile.uid !== root.uid ||
        (profile.mode & 0o777) !== 0o700
    )
        throw new Error("Invalid saved browser profile directory.");
    const stale: string[] = [];
    for (const name of [
        "SingletonLock",
        "SingletonCookie",
        "SingletonSocket",
        "DevToolsActivePort",
    ]) {
        const file = path.join(selected, name);
        const metadata = await lstat(file).catch((error: unknown) => {
            if (
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "ENOENT"
            )
                return null;
            throw error;
        });
        if (!metadata) continue;
        if (
            metadata.uid !== root.uid ||
            (name === "DevToolsActivePort"
                ? !metadata.isFile()
                : !metadata.isSymbolicLink())
        )
            throw new Error("Unexpected browser profile runtime entry.");
        stale.push(file);
    }
    // Never follow runtime links or traverse stored content. Exclusive database
    // ownership and Docker mount inspection prove the old browser is absent.
    for (const file of stale) await unlink(file);
}
