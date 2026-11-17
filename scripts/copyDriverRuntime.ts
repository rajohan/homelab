import { cp, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dependencies } from "../package.json";

/**
 * Copy the locked CUA runtime for Windows or Linux from installed root dependencies.
 * @param outputRoot - Caller-owned package directory; no download or patch is performed.
 * @returns Completion after copying the SDK and its native runtime dependencies.
 */
export async function copyDriverRuntime(outputRoot: string): Promise<void> {
    if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform))
        throw new Error("The native driver package requires Windows or Linux x64.");
    const root = fileURLToPath(new URL("..", import.meta.url));
    const computerDriverVersion = dependencies["@trycua/cua-driver"];
    const sdk = await packageRoot("@trycua/cua-driver", root);
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
    const platform = process.platform === "win32" ? "win32-x64-msvc" : "linux-x64-gnu";
    const nodeAddon = `@ubjs/node-${platform}`;
    const nodeAddonVersion = nodeMetadata.optionalDependencies[nodeAddon];
    if (
        nodeMetadata.version !== sdkMetadata.dependencies["@ubjs/node"] ||
        nodeAddonVersion !== nodeMetadata.version
    )
        throw new Error("The Native N-API dependency needs requalification.");
    const packages = [
        ["@trycua/cua-driver", sdk, computerDriverVersion],
        [
            `@trycua/cua-driver-${platform}`,
            await packageRoot(`@trycua/cua-driver-${platform}/package.json`, sdk),
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
