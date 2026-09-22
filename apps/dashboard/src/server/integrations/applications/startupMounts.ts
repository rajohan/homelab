import path from "node:path";

/**
 * Qualify mount/code relationships using bounded metadata-only filesystem reads.
 * @param paths - In-memory startup paths, or null when execution cannot be qualified.
 * @param destinations - Effective container mount destinations, never host sources.
 * @param stat - HEAD-only Docker metadata reader; null denotes a missing image path.
 * @returns Per-mount code flags; unavailable or ambiguous metadata fails closed.
 */
export async function qualifyStartupMounts(
    paths: readonly string[] | null,
    destinations: readonly string[],
    stat: (name: string) => Promise<{ mode: number; linkTarget: string } | null>
): Promise<boolean[]> {
    const blocked = destinations.map(() => true);
    if (paths === null || paths.length > 128 || destinations.length > 64) return blocked;
    if (destinations.length === 0) return [];
    const cache = new Map<string, { mode: number; linkTarget: string } | null>();
    let probes = 0;
    const resolve = async (original: string): Promise<string> => {
        if (
            !original.startsWith("/") ||
            original.includes("\0") ||
            original.length > 2000
        )
            throw new Error("Unqualified filesystem path");
        let remaining = original.split("/").filter(Boolean);
        let current = "/",
            hops = 0;
        while (remaining.length > 0) {
            const component = remaining.shift()!;
            if (component === ".") continue;
            if (component === "..") {
                current = path.posix.dirname(current);
                continue;
            }
            current = path.posix.join(current, component);
            if (!cache.has(current)) {
                if (++probes > 256)
                    throw new Error("Filesystem metadata budget exceeded");
                cache.set(current, await stat(current));
            }
            const metadata = cache.get(current);
            if (!metadata) {
                if (remaining.includes(".."))
                    throw new Error("Unproven parent traversal");
                return path.posix.join(current, ...remaining);
            }
            if ((metadata.mode & 134_217_728) !== 0) {
                if (
                    ++hops > 32 ||
                    !metadata.linkTarget.startsWith("/") ||
                    metadata.linkTarget.includes("\0") ||
                    metadata.linkTarget.length > 2000
                )
                    throw new Error("Unqualified symbolic link");
                remaining = [
                    ...metadata.linkTarget.split("/").filter(Boolean),
                    ...remaining,
                ];
                current = "/";
            }
        }
        return current;
    };
    try {
        const root = await stat("/");
        if (!root || (root.mode & 2_147_483_648) === 0) return blocked;
        cache.set("/", root);
        const mounts: string[] = [],
            code: string[] = [];
        for (const destination of destinations) mounts.push(await resolve(destination));
        for (const name of paths) code.push(await resolve(name));
        return mounts.map((mount) =>
            code.some(
                (name) =>
                    name === mount || name.startsWith(mount.replace(/\/$/, "") + "/")
            )
        );
    } catch {
        return blocked;
    }
}
