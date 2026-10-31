import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { releaseSchemaFingerprint } from "./releaseSchema";

test("release compatibility binds migration content and identity but ignores snapshot formatting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "homelab-schema-"));
    try {
        const missing = await releaseSchemaFingerprint(root).catch(
            (error: unknown) => error
        );
        expect(missing).toBeInstanceOf(Error);
        await mkdir(path.join(root, "20261031000000_first"));
        const sql = path.join(root, "20261031000000_first/migration.sql");
        await writeFile(sql, "CREATE TABLE test (id uuid);");
        const original = await releaseSchemaFingerprint(root);
        await writeFile(path.join(root, "20261031000000_first/snapshot.json"), "{}");
        expect(await releaseSchemaFingerprint(root)).toBe(original);
        await writeFile(sql, "CREATE TABLE test (id text);");
        expect(await releaseSchemaFingerprint(root)).not.toBe(original);
        await writeFile(sql, "CREATE TABLE test (id uuid);");
        await mkdir(path.join(root, "20261031000001_second"));
        await writeFile(
            path.join(root, "20261031000001_second/migration.sql"),
            "SELECT 1;"
        );
        expect(await releaseSchemaFingerprint(root)).not.toBe(original);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
