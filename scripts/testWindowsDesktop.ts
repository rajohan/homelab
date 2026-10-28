import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as v from "valibot";

import { buildWindowsDesktop } from "./buildWindowsDesktop";

/**
 * Qualify the native launcher's private pipes, process tree and settings using isolated fixtures.
 * @returns A content-free receipt; no network, credentials or real desktop input is accessed.
 */
export async function testWindowsDesktop() {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-windows-desktop-test-"));
    try {
        const built = await buildWindowsDesktop(directory, true);
        const output = execFileSync(built.checks!, [], {
            windowsHide: true,
            timeout: 60_000,
            maxBuffer: 4096,
            encoding: "utf8",
        });
        return v.parse(
            v.strictObject({
                windowsDesktop: v.literal("passed"),
                assertions: v.pipe(v.number(), v.integer(), v.minValue(60)),
            }),
            JSON.parse(output) as unknown
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

if (import.meta.main) console.info(await testWindowsDesktop());
