import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as v from "valibot";

import { buildWindowsConsent } from "./buildWindowsConsent";

/**
 * Compile the actual native host and run its separate bounded-protocol/readiness policy tests on Windows.
 * @returns A content-free receipt; this does not claim an interactive desktop or enable native input.
 */
export async function testWindowsConsent() {
    if (process.platform !== "win32")
        throw new Error("Run Windows consent qualification on Windows.");
    const directory = await mkdtemp(path.join(tmpdir(), "mira-windows-consent-test-"));
    try {
        const built = await buildWindowsConsent(directory, true);
        // Exercise the distributed GUI binary's real redirected pipe bootstrap without opening a prompt.
        const bootstrap = spawnSync(built.host, [], {
            input: "{}\n",
            encoding: "utf8",
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 4096,
        });
        if (
            bootstrap.error ||
            bootstrap.status !== 1 ||
            bootstrap.stdout !== "" ||
            bootstrap.stderr.trim() !== "Mira local computer consent is unavailable."
        )
            throw new Error(
                "The Windows GUI host did not fail closed during pipe initialization."
            );

        const output = execFileSync(built.checks!, [], {
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: 4096,
            encoding: "utf8",
        });
        return v.parse(
            v.strictObject({
                windowsConsent: v.literal("passed"),
                assertions: v.pipe(v.number(), v.integer(), v.minValue(40)),
            }),
            JSON.parse(output) as unknown
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

if (import.meta.main) console.info(await testWindowsConsent());
