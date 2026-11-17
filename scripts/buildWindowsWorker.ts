import { cp, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWindowsCapture } from "./buildWindowsCapture";
import { buildWindowsWorkerHost } from "./buildWindowsWorkerHost";
import { copyDriverRuntime } from "./copyDriverRuntime";
import { verifyBun } from "./verifyBun";

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
    await verifyBun();
    const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    await mkdir(outputRoot, { recursive: true });
    const entries = await readdir(outputRoot);
    if (entries.length > 0) throw new Error("Worker package output must be empty.");
    const { host } = await buildWindowsWorkerHost(outputRoot);
    const temporary = await mkdtemp(path.join(tmpdir(), "mira-capture-build-"));
    try {
        const capture = await buildWindowsCapture(temporary);
        await cp(capture, path.join(outputRoot, "mira-window-capture.exe"), {
            force: false,
            errorOnExist: true,
        });
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
    const worker = path.join(outputRoot, "mira-computer-worker.exe");
    const build = Bun.spawn(
        [
            process.execPath,
            "build",
            "--compile",
            `--compile-executable-path=${process.execPath}`,
            "--target=bun-windows-x64",
            "--windows-icon=" + path.join(root, "packages/ui/src/assets/rajohan.ico"),
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
    await copyDriverRuntime(outputRoot);
    return { host, worker };
}

if (import.meta.main) {
    const [directory, ...extra] = process.argv.slice(2);
    if (!directory || !path.isAbsolute(directory) || extra.length > 0)
        throw new Error("Provide one absolute, empty worker package directory.");
    console.info(await buildWindowsWorker(directory));
}
