import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Fingerprint the ordered dashboard migration programs and their immutable directory identities.
 * @param directory - Repository-owned dashboard migrations directory.
 * @returns A SHA-256 identity for automatic deployment compatibility; no database is accessed.
 */
export async function releaseSchemaFingerprint(directory: string): Promise<string> {
    const directoryEntries = await readdir(directory, { withFileTypes: true });
    const entries = directoryEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted();
    if (entries.length === 0) throw new Error("Dashboard migrations are missing");
    const migrations = await Promise.all(
        entries.map(async (name) => ({
            name,
            sha256: new Bun.CryptoHasher("sha256")
                .update(await readFile(path.join(directory, name, "migration.sql")))
                .digest("hex"),
        }))
    );
    return new Bun.CryptoHasher("sha256")
        .update(JSON.stringify({ version: 1, migrations }))
        .digest("hex");
}
if (import.meta.main)
    console.log(
        await releaseSchemaFingerprint(
            path.resolve(import.meta.dir, "../apps/dashboard/migrations")
        )
    );
