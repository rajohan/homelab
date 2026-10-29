import { cp, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

const packageMetadata = v.object({
    name: v.string(),
    version: v.string(),
    dependencies: v.optional(v.record(v.string(), v.string()), {}),
    optionalDependencies: v.optional(v.record(v.string(), v.string()), {}),
});

/**
 * Bundle the Linux browser worker with only its locked native SDK packages.
 * @param outputRoot - Absolute empty package directory owned by the build.
 * @returns The package directory; no dependencies are fetched or patched.
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
    const app = v.parse(
        v.object({ dependencies: v.record(v.string(), v.string()) }),
        await Bun.file(path.join(root, "apps/mira/package.json")).json()
    );
    const version = app.dependencies["@trycua/cua-driver"]!;
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Pin the browser SDK.");
    const sdk = await packageRoot("@trycua/cua-driver", path.join(root, "apps/mira"));
    const metadata = v.parse(
        packageMetadata,
        JSON.parse(await readFile(path.join(sdk, "package.json"), "utf8"))
    );
    if (
        metadata.version !== version ||
        Object.keys(metadata.dependencies).toSorted().join(",") !==
            "@ubjs/core,@ubjs/node"
    )
        throw new Error("The browser SDK needs requalification.");
    const node = await packageRoot("@ubjs/node", sdk);
    const nodeMetadata = v.parse(
        packageMetadata,
        JSON.parse(await readFile(path.join(node, "package.json"), "utf8"))
    );
    const addon = "@ubjs/node-linux-x64-gnu";
    if (
        nodeMetadata.version !== metadata.dependencies["@ubjs/node"] ||
        nodeMetadata.optionalDependencies[addon] !== nodeMetadata.version
    )
        throw new Error("The browser N-API dependency needs requalification.");
    const packages = [
        ["@trycua/cua-driver", sdk, version],
        [
            "@trycua/cua-driver-linux-x64-gnu",
            await packageRoot("@trycua/cua-driver-linux-x64-gnu/package.json", sdk),
            version,
        ],
        [addon, await packageRoot(addon + "/package.json", node), nodeMetadata.version],
        ...(await Promise.all(
            Object.entries(metadata.dependencies).map(async ([name, pinned]) => [
                name,
                await packageRoot(name, sdk),
                pinned,
            ])
        )),
    ];
    for (const [name, source, pinned] of packages) {
        const item = v.parse(
            packageMetadata,
            JSON.parse(await readFile(path.join(source!, "package.json"), "utf8"))
        );
        if (item.name !== name || item.version !== pinned)
            throw new Error("Unexpected browser runtime package.");
        await copyPackage(source!, path.join(outputRoot, "node_modules", name));
    }
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

async function packageRoot(name: string, from: string) {
    let directory = path.dirname(Bun.resolveSync(name, from));
    const expected = name.replace(/\/package\.json$/, "");
    while (true) {
        try {
            const metadata = v.parse(
                packageMetadata,
                JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))
            );
            if (metadata.name === expected) return await realpath(directory);
        } catch {
            /* Package entrypoints can be nested below their metadata. */
        }
        const parent = path.dirname(directory);
        if (parent === directory)
            throw new Error("Browser dependency metadata is missing.");
        directory = parent;
    }
}

async function copyPackage(source: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const input = path.join(source, entry.name),
            output = path.join(destination, entry.name);
        if (entry.isDirectory()) await copyPackage(input, output);
        else if (entry.isFile())
            await cp(input, output, { errorOnExist: true, force: false });
        else
            throw new Error(
                "Browser packages must contain ordinary files and directories."
            );
    }
}

if (import.meta.main) {
    const [directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length > 0)
        throw new Error("Provide one absolute empty browser package directory.");
    await buildBrowser(directory);
}
