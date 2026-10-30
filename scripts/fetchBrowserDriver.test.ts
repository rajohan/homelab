import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fetchBrowserDriver } from "./fetchBrowserDriver";

test.skipIf(process.platform !== "linux")(
    "browser CLI build rejects failed, truncated, oversized and tampered archives before extraction",
    async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "mira-driver-fetch-"));
        const pin = (await Bun.file(
            new URL(
                "../apps/mira/src/server/browsing/driverRelease.json",
                import.meta.url
            )
        ).json()) as { bytes: number; url: string };
        try {
            for (const mode of ["http", "truncated", "oversized", "digest"] as const) {
                await assert.rejects(
                    fetchBrowserDriver(
                        path.join(directory, "cua-driver"),
                        (url, options) => {
                            expect(url).toBe(pin.url);
                            expect(options.signal).toBeInstanceOf(AbortSignal);
                            if (mode === "http")
                                return Promise.resolve(
                                    new Response(null, { status: 503 })
                                );
                            const size =
                                mode === "truncated"
                                    ? 1
                                    : pin.bytes + (mode === "oversized" ? 1 : 0);
                            return Promise.resolve(new Response(Buffer.alloc(size, 65)));
                        }
                    )
                );
                expect(await readdir(directory)).toEqual([]);
            }
            await assert.rejects(fetchBrowserDriver("relative"), /absolute output/);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
);
