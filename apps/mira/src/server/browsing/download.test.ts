import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBrowserDownloads } from "./download";

const signal = () => new AbortController().signal;
test("native downloads bind opaque artifact IDs to exact bytes and remove collected files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-download-test-"));
    try {
        const downloads = await createBrowserDownloads(directory);
        const bytes = Buffer.alloc(100_003, 65),
            id = randomUUID();
        await writeFile(path.join(downloads.root, id), bytes);
        const result = await downloads.collect(
            { status: "completed", download_id: id, bytes: bytes.length },
            signal()
        );
        expect(result.bytes.equals(bytes)).toBe(true);
        expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        expect(await readdir(downloads.root)).toEqual([]);
        await assert.rejects(
            downloads.collect(
                { status: "completed", download_id: id, bytes: bytes.length },
                signal()
            )
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("native download collection rejects partials, wrong sizes, paths, links and cancellation", async () => {
    for (const scenario of [
        "partial",
        "size",
        "empty",
        "oversize",
        "path",
        "extra",
        "symlink",
        "hardlink",
        "cancelled",
    ] as const) {
        const directory = await mkdtemp(path.join(tmpdir(), "mira-download-test-"));
        try {
            const downloads = await createBrowserDownloads(directory);
            const id = randomUUID(),
                file = path.join(downloads.root, id);
            const receipt = { status: "completed", download_id: id as string, bytes: 5 };
            if (scenario === "symlink" || scenario === "hardlink") {
                const outside = path.join(directory, "outside");
                await writeFile(outside, "hello");
                await (scenario === "symlink"
                    ? symlink(outside, file)
                    : link(outside, file));
            } else await writeFile(file, "hello");
            if (scenario === "partial") receipt.status = "pending";
            if (scenario === "size") receipt.bytes = 6;
            if (scenario === "empty") receipt.bytes = 0;
            if (scenario === "oversize") receipt.bytes = 25 * 1024 * 1024 + 1;
            if (scenario === "path") receipt.download_id = "../outside";
            if (scenario === "extra")
                await writeFile(path.join(downloads.root, "partial.crdownload"), "x");
            const owner = new AbortController();
            if (scenario === "cancelled") owner.abort();
            await assert.rejects(downloads.collect(receipt, owner.signal));
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
});

test("native download lifetime count is not reset by deleting completed artifacts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-download-test-"));
    try {
        const downloads = await createBrowserDownloads(directory);
        for (let n = 0; n < 17; n++) {
            const id = randomUUID();
            await writeFile(path.join(downloads.root, id), "x");
            const pending = downloads.collect(
                { status: "completed", download_id: id, bytes: 1 },
                signal()
            );
            await (n === 16 ? assert.rejects(pending, /quota/) : pending);
        }
        await assert.rejects(createBrowserDownloads("relative"), /canonical/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
