import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwind from "bun-plugin-tailwind";

const repositoryRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const applicationsRoot = path.resolve(repositoryRoot, "apps");

const requested = process.argv.slice(2);
const apps = requested.length === 0 ? ["auth", "dashboard"] : requested;

if (apps.some((app) => app !== "auth" && app !== "dashboard")) {
    throw new Error("Usage: bun run build [auth|dashboard]");
}

for (const app of apps) {
    const applicationRoot = path.resolve(applicationsRoot, app);
    const outputDirectory = path.resolve(applicationRoot, "dist");
    if (
        (await realpath(applicationRoot)) !== applicationRoot ||
        !outputDirectory.startsWith(`${applicationsRoot}${path.sep}`) ||
        path.basename(outputDirectory) !== "dist"
    ) {
        throw new Error("Refusing to clean output outside the selected application.");
    }
    await rm(outputDirectory, { recursive: true, force: true });

    const result = await Bun.build({
        entrypoints: [path.resolve(applicationRoot, "src/server.ts")],
        outdir: outputDirectory,
        target: "bun",
        minify: true,
        sourcemap: "none",
        env: "disable",
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        plugins: [tailwind],
    });
    if (!result.success) {
        for (const message of result.logs) {
            console.error(message);
        }
        throw new Error(`The ${app} build failed.`);
    }
    console.info(`Built ${app}: ${result.outputs.length} artifacts in apps/${app}/dist.`);
}
