import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    browserUploadLimit,
    createBrowserUploads,
    type BrowserUploadFile,
} from "./upload";

function file(
    bytes = new TextEncoder().encode("Approved attachment")
): BrowserUploadFile {
    return {
        name: "report.txt",
        size: bytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        bytes,
    };
}
async function fixture() {
    const root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "mira-upload-test-"))
    );
    return {
        root,
        store: await createBrowserUploads(root),
        close: () => rm(root, { recursive: true, force: true }),
    };
}
const signal = () => new AbortController().signal;

test("upload staging copies approved bytes before asynchronous work and retains delayed form inputs", async () => {
    const f = await fixture();
    try {
        const input = file();
        const expected = Uint8Array.from(input.bytes);
        const pending = f.store.stage(input, signal());
        input.bytes.fill(0);
        const first = await pending;
        const second = await f.store.stage(file(), signal());
        expect(first).not.toBe(second);
        expect(path.basename(first)).toBe("report.txt");
        expect(await readFile(first)).toEqual(Buffer.from(expected));
        expect(await readFile(second)).toEqual(Buffer.from(expected));
        await f.close();
        expect(await Bun.file(first).exists()).toBe(false);
        expect(await Bun.file(second).exists()).toBe(false);
    } finally {
        await f.close();
    }
});

test("upload staging rejects unapproved paths, names, lengths and digest changes before creating files", async () => {
    const f = await fixture();
    try {
        for (const patch of [
            { name: "../secret" },
            { name: "a/b" },
            { name: String.raw`a\b` },
            { name: "." },
            { name: ".." },
            { name: " " },
            { name: "\u0000bad" },
            { name: "\uD800" },
            { name: "\u00E9".repeat(101) },
            { size: 0 },
            { size: browserUploadLimit + 1 },
            { size: 1.5 },
            { size: 1 },
            { sha256: "0".repeat(64) },
            { bytes: new Uint8Array() },
            { path: "/private/secret" },
        ])
            await assert.rejects(f.store.stage({ ...file(), ...patch }, signal()));
        expect(await readdir(f.store.root)).toEqual([]);
    } finally {
        await f.close();
    }
});

test("upload staging bounds total bytes and file count for the entire browser lifetime", async () => {
    const f = await fixture();
    try {
        await f.store.stage(file(new Uint8Array(browserUploadLimit)), signal());
        await assert.rejects(f.store.stage(file(), signal()), /quota/);
    } finally {
        await f.close();
    }
    const small = await fixture();
    try {
        for (let i = 0; i < 16; i++)
            await small.store.stage(file(new Uint8Array([1])), signal());
        await assert.rejects(
            small.store.stage(file(new Uint8Array([1])), signal()),
            /quota/
        );
    } finally {
        await small.close();
    }
});

test("cancelled uploads cannot create files and a removed session root is never recreated", async () => {
    const f = await fixture();
    try {
        const abort = new AbortController();
        abort.abort();
        await assert.rejects(f.store.stage(file(), abort.signal));
        expect(await readdir(f.store.root)).toEqual([]);
        await f.close();
        await assert.rejects(f.store.stage(file(), signal()));
        await assert.rejects(readdir(f.root));
    } finally {
        await f.close();
    }
});

test("staging roots must be canonical and cannot reuse an existing directory or link", async () => {
    const f = await fixture();
    try {
        await assert.rejects(createBrowserUploads("relative"));
        await assert.rejects(createBrowserUploads(f.root));
        if (process.platform !== "win32") {
            const link = path.join(f.root, "link");
            await symlink(f.store.root, link);
            await assert.rejects(createBrowserUploads(link));
        }
    } finally {
        await f.close();
    }
});
