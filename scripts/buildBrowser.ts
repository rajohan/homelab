import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { copyDriverRuntime } from "./copyDriverRuntime";

/**
 * Bundle the Linux browser worker with the same locked native SDK as Windows.
 * @param outputRoot - Absolute empty package directory owned by the build.
 * @returns The package directory with managed native dependencies.
 */
export async function buildBrowser(outputRoot: string) {
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
    await copyDriverRuntime(outputRoot);
    const result = await Bun.build({
        entrypoints: [path.join(root, "apps/mira/src/server/browsing/workerCli.ts")],
        outdir: outputRoot,
        naming: "worker.js",
        target: "bun",
        external: ["@trycua/cua-driver"],
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
