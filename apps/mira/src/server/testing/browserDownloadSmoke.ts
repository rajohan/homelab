import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { openNativeBrowser } from "../browsing/native";

/**
 * Qualify the official download tool with a real isolated Chromium link and byte-for-byte receipt.
 * @returns A content-free proof; this private native operation is not exposed to model tools or Chat yet.
 */
export async function qualifyBrowserDownloads() {
    const bytes = Buffer.alloc(100_003, 65);
    let downloads = 0;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
            if (new URL(request.url).pathname === "/file") {
                downloads++;
                return new Response(bytes, {
                    headers: {
                        "Content-Type": "application/octet-stream",
                        "Content-Disposition": 'attachment; filename="fixture.txt"',
                    },
                });
            }
            return new Response(
                '<!doctype html><title>Download fixture</title><a href="/file" download>Download fixture</a>',
                {
                    headers: { "Content-Type": "text/html" },
                }
            );
        },
    });
    const owner = AbortSignal.timeout(60_000);
    const grant = {
        executable: "/usr/lib/chromium/chromium",
        mode: "control",
        downloads: true,
        origins: [server.url.origin],
        initialUrl: server.url.href,
    };
    const active: Awaited<ReturnType<typeof openNativeBrowser>>[] = [];
    try {
        for (const operator of [false, true]) {
            const browser = await openNativeBrowser(grant, owner);
            active.push(browser);
            const frame = await browser.observe(owner, operator);
            const link = frame.refs.find(
                (item) => item.label === "Download fixture" && item.role === "link"
            );
            assert.ok(link);
            const command = { observationId: frame.observationId, ref: link.ref };
            if (operator) {
                const result = await browser.download(command, owner);
                assert.deepEqual(result.bytes, bytes);
                assert.equal(
                    result.sha256,
                    createHash("sha256").update(bytes).digest("hex")
                );
                assert.equal(downloads, 1);
                await assert.rejects(browser.download(command, owner), /operator link/);
            } else {
                await assert.rejects(browser.download(command, owner), /operator link/);
                assert.equal(downloads, 0);
            }
            await browser.close();
        }
        return {
            nativeDownload: true,
            verifiedBytes: bytes.length,
            modelDenied: true,
            replayDenied: true,
        };
    } finally {
        try {
            for (const browser of active) await browser.close();
        } finally {
            await server.stop(true);
        }
    }
}
