import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    computerReleaseNames,
    hashComputerFile,
    readComputerRelease,
    verifyComputerPackage,
} from "./computerRelease";

/**
 * Compile the standard per-user installer from an already qualified immutable payload.
 * @param options - Caller-owned build paths, verified compiler and bounded release metadata.
 * @returns The setup executable and exact digest; this does not install or launch Mira.
 */
export async function buildComputerInstaller(options: {
    directory: string;
    output: string;
    compiler: string;
    manifest: unknown;
}) {
    if (
        process.platform !== "win32" ||
        [options.directory, options.output, options.compiler].some(
            (value) => !path.isAbsolute(value) || /["\r\n]/.test(value)
        )
    )
        throw new Error("Installer builds require absolute Windows paths.");
    const release = readComputerRelease(options.manifest);
    await verifyComputerPackage(options.directory, release);
    const pinned = JSON.parse(
        await readFile(new URL("../deploy/computer/inno.json", import.meta.url), "utf8")
    ) as { version: string };
    const compilerVersion = execFileSync(options.compiler, ["--version"], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 5000,
    }).trim();
    if (compilerVersion !== pinned.version)
        throw new Error("Use the pinned, publisher-verified Inno Setup compiler.");
    await mkdir(options.output);
    const entries = path.join(options.output, "payload-files.iss");
    const inventory = path.join(options.output, "payload-inventory.iss");
    await writeFile(
        entries,
        release.files
            .map((file) => {
                const relative = file.path.replaceAll("/", "\\");
                const destination = path.win32.dirname(relative);
                return `Source: "${path.join(options.directory, file.path)}"; DestDir: "{app}\\versions\\${release.version}${destination === "." ? "" : `\\${destination}`}"; Flags: onlyifdoesntexist`;
            })
            .join("\n") + "\n",
        { flag: "wx" }
    );
    await writeFile(
        inventory,
        [
            `SetArrayLength(ExpectedPaths, ${release.files.length});`,
            `SetArrayLength(ExpectedHashes, ${release.files.length});`,
            ...release.files.flatMap((file, index) => [
                `ExpectedPaths[${index}] := '${file.path.replaceAll("/", "\\")}';`,
                `ExpectedHashes[${index}] := '${file.sha256}';`,
            ]),
        ].join("\n") + "\n",
        { flag: "wx" }
    );
    let script = await readFile(
        new URL("../deploy/computer/installer.iss", import.meta.url),
        "utf8"
    );
    for (const [key, value] of Object.entries({
        VERSION: release.version,
        ICON: fileURLToPath(
            new URL("../packages/ui/src/assets/rajohan.ico", import.meta.url)
        ),
        OUTPUT: options.output,
        FILES: entries,
        INVENTORY: inventory,
    }))
        script = script.replaceAll(`@${key}@`, value);
    const source = path.join(options.output, "installer.iss");
    await writeFile(source, script, { flag: "wx" });
    execFileSync(options.compiler, ["--no-ide-signtools", "/Q", source], {
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 64 * 1024,
    });
    // Confirm the compiler consumed unchanged qualified bytes.
    await verifyComputerPackage(options.directory, release);
    const name = computerReleaseNames(release.version).installer;
    const executable = path.join(options.output, name);
    return { executable, metadata: { name, ...(await hashComputerFile(executable)) } };
}
