import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchBrowserDriver } from "./fetchBrowserDriver";

/**
 * Bundle the Linux browser worker and its hash-pinned official CLI.
 * @param outputRoot - Absolute empty package directory owned by the build.
 * @param installDriver - Hash-verifying release installer; synthetic replacement is for offline tests only.
 * @returns The package directory with the verified upstream executable; no SDK patches.
 */
export async function buildBrowser(
    outputRoot: string,
    installDriver = fetchBrowserDriver
) {
    if (
        process.platform !== "linux" ||
        process.arch !== "x64" ||
        !path.isAbsolute(outputRoot)
    )
        throw new Error("The browser image requires Linux x64 and absolute output.");
    const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    await mkdir(outputRoot, { recursive: true });
    const entries = await readdir(outputRoot);
    if (entries.length > 0) throw new Error("Browser package output must be empty.");
    await installDriver(path.join(outputRoot, "cua-driver"));
    const result = await Bun.build({
        entrypoints: [path.join(root, "apps/mira/src/server/browsing/workerCli.ts")],
        outdir: outputRoot,
        naming: "worker.js",
        target: "bun",
        sourcemap: "none",
        env: "disable",
        minify: { whitespace: true, identifiers: false, syntax: false, keepNames: true },
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });
    if (!result.success) throw new Error("Browser worker build failed.");
    await Bun.write(
        path.join(outputRoot, "package.json"),
        JSON.stringify({ private: true, type: "module" })
    );
    return outputRoot;
}

if (import.meta.main) {
    const [directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length > 0)
        throw new Error("Provide one absolute empty browser package directory.");
    await buildBrowser(directory);
}
