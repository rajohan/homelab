import { execFileSync } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildComputerDistribution } from "./buildComputerDistribution";
import { buildComputerInstaller } from "./buildComputerInstaller";
import { readComputerRelease } from "./computerRelease";

/** Build the Windows release assets without running or installing the application. */
async function main() {
    const [directory, compiler, ...extra] = process.argv.slice(2);
    if (!directory || !compiler || extra.length > 0)
        throw new Error("Provide an absolute output directory and installer compiler.");
    const root = path.resolve(directory);
    await mkdir(root, { recursive: true });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
    }).trim();
    const distribution = await buildComputerDistribution(
        path.join(root, "build"),
        revision
    );
    const installer = await buildComputerInstaller({
        directory: distribution.directory,
        output: path.join(root, "installer"),
        compiler: path.resolve(compiler),
        manifest: distribution.metadata,
    });
    const output = path.join(root, "release");
    await mkdir(output);
    for (const file of [distribution.archive, installer.executable])
        await cp(file, path.join(output, path.basename(file)), {
            errorOnExist: true,
            force: false,
        });
    await writeFile(
        path.join(output, path.basename(distribution.manifest)),
        JSON.stringify(
            readComputerRelease({
                ...distribution.metadata,
                installer: installer.metadata,
            }),
            null,
            2
        ) + "\n",
        { flag: "wx" }
    );
}

if (import.meta.main) await main();
