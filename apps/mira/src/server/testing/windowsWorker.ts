import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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
const runtime = JSON.parse(execFileSync(worker, ["--check-runtime"], options)) as unknown;
if (
    JSON.stringify(runtime) !==
    JSON.stringify({
        driver: computerDriverVersion,
        embedded: true,
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
const dll = path.join(
    directory,
    "node_modules/@trycua/cua-driver-win32-x64-msvc/cua_driver_sdk.dll"
);
await rename(dll, dll + ".missing");
let refused = false;
try {
    execFileSync(worker, ["--check-runtime"], options);
} catch {
    refused = true;
}
if (!refused) throw new Error("A missing packaged native library was not rejected.");
