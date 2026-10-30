import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as v from "valibot";

const pin = v.parse(
    v.object({
        version: v.string(),
        url: v.string(),
        bytes: v.number(),
        sha256: v.string(),
    }),
    await Bun.file(
        new URL("../apps/mira/src/server/browsing/driverRelease.json", import.meta.url)
    ).json()
);

/**
 * Fetch the reviewed official Linux CLI archive during image builds and verify it before extraction.
 * @param output - Absolute new executable path inside the build output directory.
 * @param download - Build-time HTTPS fetch; synthetic replacement keeps unit tests offline.
 * @returns Completion after the exact regular binary member has been extracted and made executable.
 */
export async function fetchBrowserDriver(
    output: string,
    download: (url: string, options: RequestInit) => Promise<Response> = fetch
): Promise<void> {
    if (
        process.platform !== "linux" ||
        process.arch !== "x64" ||
        !path.isAbsolute(output)
    )
        throw new Error(
            "The browser CLI package requires Linux x64 and absolute output."
        );
    const directory = await mkdtemp(path.join(tmpdir(), "mira-browser-build-"));
    let destination;
    try {
        const response = await download(pin.url, {
            signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok || !response.body)
            throw new Error("Official browser driver download failed.");
        const archive = path.join(directory, "driver.tar.gz");
        const file = await open(archive, "wx", 0o600);
        const hash = createHash("sha256");
        let size = 0;
        try {
            for await (const value of response.body) {
                if (!(value instanceof Uint8Array))
                    throw new Error("Invalid archive data.");
                const chunk = value;
                size += chunk.byteLength;
                if (size > pin.bytes)
                    throw new Error("Browser driver archive exceeds its pinned size.");
                hash.update(chunk);
                await file.writeFile(chunk);
            }
        } finally {
            await file.close();
        }
        if (size !== pin.bytes || hash.digest("hex") !== pin.sha256)
            throw new Error(
                "Browser driver archive does not match the reviewed release."
            );
        // The hash-attested release contains this single regular executable. Never extract
        // archive paths, links or permissions into the build tree.
        destination = await open(output, "wx", 0o600);
        const child = Bun.spawn(["tar", "-xOzf", archive, "--", "cua-driver"], {
            stdin: "ignore",
            stdout: destination.fd,
            stderr: "ignore",
        });
        if ((await child.exited) !== 0)
            throw new Error("Browser driver extraction failed.");
        await destination.close();
        destination = undefined;
        await chmod(output, 0o755);
    } catch (error) {
        if (destination) {
            await destination.close();
            await rm(output, { force: true });
        }
        throw error;
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const [output, ...extra] = process.argv.slice(2);
    if (!output || extra.length > 0)
        throw new Error("Provide one new absolute CLI output path.");
    await fetchBrowserDriver(output);
}
