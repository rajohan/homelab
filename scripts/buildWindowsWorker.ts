import { cp, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWindowsWorkerHost } from "./buildWindowsWorkerHost";

/**
 * Package the compiled Bun worker with the locked SDK JavaScript, native DLL and N-API module.
 * @param outputRoot - Empty caller-owned package directory; no dependencies are fetched or patched.
 * @returns Paths to the fixed supervisor and self-contained worker runtime.
 */
export async function buildWindowsWorker(outputRoot: string) {
    if (
        process.platform !== "win32" ||
        process.arch !== "x64" ||
        !path.isAbsolute(outputRoot)
    )
        throw new Error("The Windows worker requires Windows x64 and absolute output.");
    const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    const app = (await Bun.file(path.join(root, "apps/mira/package.json")).json()) as {
        dependencies: Record<string, string>;
    };
    const computerDriverVersion = app.dependencies["@trycua/cua-driver"];
    if (!computerDriverVersion || !/^\d+\.\d+\.\d+$/.test(computerDriverVersion))
        throw new Error("The computer SDK must be pinned.");
    await mkdir(outputRoot, { recursive: true });
    const entries = await readdir(outputRoot);
    if (entries.length > 0) throw new Error("Worker package output must be empty.");
    const { host } = await buildWindowsWorkerHost(outputRoot);
    const worker = path.join(outputRoot, "mira-computer-worker.exe");
    const build = Bun.spawn(
        [
            process.execPath,
            "build",
            "--compile",
            "--target=bun-windows-x64",
            "--no-compile-autoload-dotenv",
            "--no-compile-autoload-bunfig",
            "--no-compile-autoload-tsconfig",
            "--compile-autoload-package-json",
            "--external=@trycua/cua-driver",
            `--outfile=${worker}`,
            path.join(root, "apps/mira/src/server/computer/workerCli.ts"),
        ],
        {
            cwd: root,
            stdout: "ignore",
            stderr: "inherit",
            timeout: 120_000,
            windowsHide: true,
        }
    );
    if ((await build.exited) !== 0) throw new Error("Windows worker build failed.");
    const sdk = await packageRoot("@trycua/cua-driver", path.join(root, "apps/mira"));
    const sdkMetadata = JSON.parse(
        await readFile(path.join(sdk, "package.json"), "utf8")
    ) as {
        version: string;
        dependencies: Record<string, string>;
    };
    if (
        sdkMetadata.version !== computerDriverVersion ||
        Object.keys(sdkMetadata.dependencies).toSorted().join(",") !==
            "@ubjs/core,@ubjs/node"
    )
        throw new Error("The computer SDK package needs requalification.");
    const node = await packageRoot("@ubjs/node", sdk);
    const nodeMetadata = JSON.parse(
        await readFile(path.join(node, "package.json"), "utf8")
    ) as { version: string; optionalDependencies: Record<string, string> };
    const nodeAddon = "@ubjs/node-win32-x64-msvc";
    const nodeAddonVersion = nodeMetadata.optionalDependencies[nodeAddon];
    if (
        nodeMetadata.version !== sdkMetadata.dependencies["@ubjs/node"] ||
        nodeAddonVersion !== nodeMetadata.version
    )
        throw new Error("The Windows N-API dependency needs requalification.");
    const packages = [
        ["@trycua/cua-driver", sdk, computerDriverVersion],
        [
            "@trycua/cua-driver-win32-x64-msvc",
            await packageRoot("@trycua/cua-driver-win32-x64-msvc/package.json", sdk),
            computerDriverVersion,
        ],
        [
            nodeAddon,
            await packageRoot(nodeAddon + "/package.json", node),
            nodeAddonVersion,
        ],
        ...(await Promise.all(
            Object.entries(sdkMetadata.dependencies).map(async ([name, version]) => [
                name,
                await packageRoot(name, sdk),
                version,
            ])
        )),
    ];
    for (const [name, source, version] of packages) {
        const metadata = JSON.parse(
            await readFile(path.join(source!, "package.json"), "utf8")
        ) as { name: string; version: string };
        if (metadata.name !== name || metadata.version !== version)
            throw new Error("Unexpected computer runtime package.");
        await copyPackage(source!, path.join(outputRoot, "node_modules", name));
    }
    return { host, worker };
}

async function packageRoot(name: string, from: string) {
    let directory = path.dirname(Bun.resolveSync(name, from));
    const expected = name.replace(/\/package\.json$/, "");
    while (true) {
        try {
            const metadata = JSON.parse(
                await readFile(path.join(directory, "package.json"), "utf8")
            ) as { name: string };
            if (metadata.name === expected) return await realpath(directory);
        } catch {
            /* Package entrypoints can be nested below their metadata. */
        }
        const parent = path.dirname(directory);
        if (parent === directory)
            throw new Error("Computer dependency metadata is missing.");
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
                "Computer packages must contain ordinary files and directories."
            );
    }
}

if (import.meta.main) {
    const [directory, ...extra] = process.argv.slice(2);
    if (!directory || !path.isAbsolute(directory) || extra.length > 0)
        throw new Error("Provide one absolute, empty worker package directory.");
    console.info(await buildWindowsWorker(directory));
}
