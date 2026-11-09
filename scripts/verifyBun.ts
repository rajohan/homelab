import { readFile } from "node:fs/promises";

/** Verify the exact runtime revision; Canary's short version also identifies stable Bun. */
export async function verifyBun(): Promise<void> {
    const revisionFile = await readFile(
        new URL("../.bun-revision", import.meta.url),
        "utf8"
    );
    const expected = revisionFile.trim();
    if (!/^[a-f0-9]{40}$/.test(expected) || Bun.revision !== expected)
        throw new Error(
            `Use the pinned Bun revision ${expected}; running ${Bun.revision}.`
        );
}

if (import.meta.main) await verifyBun();
