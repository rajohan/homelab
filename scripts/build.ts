import { cp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwind from "bun-plugin-tailwind";

/**
 * Build the requested applications into their independently deployable packages.
 * @returns Completion after the selected builds and asset copies finish.
 */
export async function main(): Promise<void> {
    const repositoryRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    const applicationsRoot = path.resolve(repositoryRoot, "apps");

    const requested = process.argv.slice(2);
    const apps = requested.length === 0 ? ["auth", "dashboard", "mira"] : requested;

    if (apps.some((app) => !["auth", "dashboard", "mira"].includes(app))) {
        throw new Error("Usage: bun run build [auth|dashboard|mira]");
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

        const additionalEntries =
            app === "dashboard"
                ? [
                      path.resolve(applicationRoot, "src/worker/worker.ts"),
                      path.resolve(applicationRoot, "src/worker/migrate.ts"),
                  ]
                : [
                      path.resolve(
                          applicationRoot,
                          app === "auth"
                              ? "src/server/cli/admin.ts"
                              : "src/server/testing/smoke.ts"
                      ),
                  ];
        const result = await Bun.build({
            entrypoints: [
                path.resolve(applicationRoot, "src/server/index.ts"),
                ...(app === "auth"
                    ? []
                    : [
                          path.resolve(
                              applicationsRoot,
                              "mira/src/server/files/miraPdf.ts"
                          ),
                      ]),
                ...additionalEntries,
            ],
            outdir: outputDirectory,
            // SPA deep links must load the same assets as the site root.
            publicPath: "/",
            naming: { entry: "[name].[ext]" },
            target: "bun",
            reactCompiler: true,
            reactCompilerOutputMode: "client",
            // Protocol libraries use class names as durable model identifiers.
            minify: {
                whitespace: true,
                syntax: false,
                identifiers: false,
                keepNames: true,
            },
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
        await cp(
            path.resolve(
                app === "mira"
                    ? path.join(applicationsRoot, "dashboard")
                    : applicationRoot,
                "migrations"
            ),
            path.resolve(outputDirectory, "migrations"),
            { recursive: true }
        );
        if (app === "dashboard")
            await cp(
                path.resolve(applicationRoot, "config"),
                path.resolve(outputDirectory, "config"),
                { recursive: true }
            );
        if (app === "mira") {
            const triples: Record<string, string> = {
                "linux-x64": "x86_64-unknown-linux-musl",
                "linux-arm64": "aarch64-unknown-linux-musl",
                "darwin-x64": "x86_64-apple-darwin",
                "darwin-arm64": "aarch64-apple-darwin",
                "win32-x64": "x86_64-pc-windows-msvc",
                "win32-arm64": "aarch64-pc-windows-msvc",
            };
            const platform = `${process.platform}-${process.arch}`;
            const triple = triples[platform];
            if (!triple) throw new Error("Unsupported Mira runtime platform.");
            const codexRoot = path.dirname(
                Bun.resolveSync("@openai/codex/package.json", applicationRoot)
            );
            const nativeRoot = path.dirname(
                Bun.resolveSync(`@openai/codex-${platform}/package.json`, codexRoot)
            );
            const extension = process.platform === "win32" ? ".exe" : "";
            const destination = path.join(outputDirectory, "runtime");
            await mkdir(destination);
            // Code mode discovers its host beside the native Codex executable.
            for (const binary of ["codex", "codex-code-mode-host"]) {
                const executable = binary + extension;
                await cp(
                    path.join(nativeRoot, "vendor", triple, "bin", executable),
                    path.join(destination, executable)
                );
            }
        }
        console.info(
            `Built ${app}: ${result.outputs.length} artifacts in apps/${app}/dist.`
        );
    }
}

if (import.meta.main) await main();
