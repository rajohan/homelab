import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { writeComputerUpdate } from "./updatePipe";

async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-update-pipe-"));
    const file = path.join(directory, "synthetic.bin");
    const bytes = randomBytes(150_000);
    await writeFile(file, bytes);
    return {
        directory,
        file,
        bytes,
        update: {
            repository: "demo/homelab",
            version: "0.11.0",
            revision: "a".repeat(40),
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            validForMs: 60_000,
        },
        close: () => rm(directory, { recursive: true, force: true }),
    };
}

test("private update pipe preserves framing and bytes through slow backpressure without ending the launcher pipe", async () => {
    const f = await fixture();
    try {
        const chunks: Buffer[] = [];
        const output = new Writable({
            highWaterMark: 1,
            write(chunk: Buffer, _encoding, callback) {
                setTimeout(() => {
                    chunks.push(Buffer.from(chunk));
                    callback();
                }, 2);
            },
        });
        await writeComputerUpdate(f.file, f.update, output, new AbortController().signal);
        const result = Buffer.concat(chunks);
        const end = result.indexOf(10);
        const receipt = JSON.parse(result.subarray(0, end).toString()) as typeof f.update;
        expect({ ...receipt, validForMs: f.update.validForMs }).toEqual(f.update);
        expect(receipt.validForMs).toBeGreaterThan(0);
        expect(receipt.validForMs).toBeLessThanOrEqual(f.update.validForMs);
        expect(result.subarray(end + 1)).toEqual(f.bytes);
        expect(result.toString()).not.toContain(f.file);
        expect(output.writableEnded).toBe(false);
        output.end();
    } finally {
        await f.close();
    }
});

test("changed or missing staged content cannot produce a successful update transfer", async () => {
    const f = await fixture();
    try {
        for (const mode of ["hash", "size", "missing"]) {
            const output = new Writable({
                write(_chunk, _encoding, callback) {
                    callback();
                },
            });
            if (mode === "hash") await writeFile(f.file, Buffer.alloc(f.bytes.length));
            if (mode === "size") await writeFile(f.file, Buffer.from("short"));
            if (mode === "missing") await rm(f.file);
            await rejects(
                writeComputerUpdate(
                    f.file,
                    f.update,
                    output,
                    new AbortController().signal
                )
            );
        }
    } finally {
        await f.close();
    }
});

test("cancellation releases a blocked update pipe and its file handle", async () => {
    const f = await fixture();
    try {
        const stop = new AbortController();
        const output = new Writable({
            write() {
                stop.abort();
            },
        });
        await rejects(writeComputerUpdate(f.file, f.update, output, stop.signal));
        expect(output.destroyed).toBe(true);
        expect(await readFile(f.file)).toEqual(f.bytes);
        await rejects(writeComputerUpdate(f.file, f.update, new Writable(), stop.signal));
    } finally {
        await f.close();
    }
});
