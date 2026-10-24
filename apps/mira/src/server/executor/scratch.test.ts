import { expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readdir,
    realpath,
    rm,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cleanupMiraScratch } from "./scratch";

test("abandoned Mira image copies expire without removing current or unrelated files", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "mira-scratch-test-")));
    const parent = path.join(home, "message-files");
    try {
        expect(await cleanupMiraScratch(home)).toBe(0);
        await mkdir(parent);
        for (const name of ["turn-Abc123", "turn-New456", "unrelated"])
            await mkdir(path.join(parent, name));
        await writeFile(path.join(parent, "turn-Abc123", "image"), "synthetic");
        const old = new Date(Date.now() - 172_800_000);
        await utimes(path.join(parent, "turn-Abc123"), old, old);
        await utimes(path.join(parent, "unrelated"), old, old);
        await symlink(
            path.join(parent, "unrelated"),
            path.join(parent, "turn-Link00"),
            "dir"
        );
        expect(await cleanupMiraScratch(home)).toBe(1);
        const remaining = await readdir(parent);
        expect(remaining.toSorted()).toEqual(["turn-Link00", "turn-New456", "unrelated"]);
        expect(await cleanupMiraScratch(home)).toBe(0);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
