import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { version } from "../../../../../package.json";
import { readComputerPackage } from "../computer/installedComputer";
import { computerDriverVersion } from "../computer/policy";
import { openWindowsComputerProcess } from "../computer/process";
import { computerEnvironment } from "../config/environment";

const [directory, root, ...extra] = process.argv.slice(2);
if (
    !directory ||
    !root ||
    extra.length > 0 ||
    !path.isAbsolute(directory) ||
    !path.isAbsolute(root)
)
    throw new Error(
        "Windows worker qualification requires owned absolute test directories."
    );
const worker = path.join(directory, "mira-computer-worker.exe");
const environment = computerEnvironment();
const unrelated = path.join(root, "unrelated");
await mkdir(unrelated);
await writeFile(path.join(unrelated, "bunfig.toml"), 'preload = ["./poison.js"]\n');
await writeFile(
    path.join(unrelated, "poison.js"),
    'throw new Error("Ambient preload executed");\n'
);
const options = {
    cwd: unrelated,
    env: environment,
    windowsHide: true,
    stdio: "pipe" as const,
    timeout: 20_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8" as const,
};
const companion = path.join(directory, "mira-computer.exe");
if ((await readComputerPackage(companion)) !== directory)
    throw new Error("Installed package directory changed.");
if (execFileSync(companion, ["--version"], options).trim() !== version)
    throw new Error("Packaged companion version differs from the repository.");
if (
    !execFileSync(companion, ["--help"], options).includes("local approval of one window")
)
    throw new Error("Packaged companion help is missing local consent.");
for (const name of [
    "mira-computer-consent.exe",
    "mira-computer-worker-host.exe",
    "mira-computer-worker.exe",
]) {
    const file = path.join(directory, name);
    await rename(file, file + ".missing");
    try {
        const result = spawnSync(
            companion,
            ["run", "https://unpaired-fixture.example.test"],
            options
        );
        if (
            result.status !== 1 ||
            !result.stderr.includes("ENOENT") ||
            !result.stderr.includes(name)
        )
            throw new Error(
                "An incomplete companion did not fail package validation before pairing."
            );
    } finally {
        await rename(file + ".missing", file);
    }
}
const runtime = JSON.parse(execFileSync(worker, ["--check-runtime"], options)) as unknown;
if (
    JSON.stringify(runtime) !==
    JSON.stringify({
        driver: computerDriverVersion,
        embedded: true,
        nativeAddons: true,
        bun: Bun.version,
    })
)
    throw new Error("Packaged native runtime qualification failed.");
// A deliberately nonexistent PID; only startup/metadata and close occur, never observation/input.
const port = await openWindowsComputerProcess(
    {
        executable: worker,
        pid: 2_147_483_647,
        windowId: "1",
        delivery: "background",
        mode: "view",
    },
    { directory, environment, signal: new AbortController().signal }
);
await port.close();
await port.close();
for (const relative of [
    "@trycua/cua-driver-win32-x64-msvc/cua_driver_sdk.dll",
    "@trycua/cua-driver-win32-x64-msvc/cua_driver_node_runtime.node",
    "@ubjs/node-win32-x64-msvc/uniffi-runtime-napi.win32-x64-msvc.node",
]) {
    const library = path.join(directory, "node_modules", relative);
    await rename(library, library + ".missing");
    let refused = false;
    try {
        execFileSync(worker, ["--check-runtime"], options);
    } catch {
        refused = true;
    } finally {
        await rename(library + ".missing", library);
    }
    if (!refused) throw new Error("A missing packaged native library was not rejected.");
}
execFileSync(worker, ["--check-runtime"], options);
