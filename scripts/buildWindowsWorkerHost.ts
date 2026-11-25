import { execFileSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compile the Windows worker supervisor.
 * @param outputRoot - Caller-owned output directory; existing content is never removed.
 * @returns Path to the supervisor executable.
 */
export async function buildWindowsWorkerHost(outputRoot?: string) {
    if (process.platform !== "win32" || process.arch !== "x64")
        throw new Error("The Windows worker requires Windows x64.");
    const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    const source = path.join(root, "apps/mira/native/windows");
    outputRoot ??= path.join(root, "apps/mira/dist/computer/windows-x64");
    if (!path.isAbsolute(outputRoot)) throw new Error("Worker output must be absolute.");
    const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!system || !path.isAbsolute(system))
        throw new Error("Windows SystemRoot is required.");
    const compiler = path.join(system, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
    await mkdir(outputRoot, { recursive: true });
    const host = path.join(outputRoot, "mira-computer-worker-host.exe");
    const common = [
        "/nologo",
        "/platform:x64",
        `/win32icon:${path.join(root, "packages/ui/src/assets/rajohan.ico")}`,
        "/warnaserror+",
        "/optimize+",
        "/target:exe",
        "/reference:System.Drawing.dll",
        "/reference:System.Windows.Forms.dll",
        "/reference:System.Web.Extensions.dll",
        `/win32manifest:${path.join(source, "app.manifest")}`,
    ];
    const compile = (outfile: string, files: string[]) =>
        execFileSync(
            compiler,
            [
                ...common,
                `/out:${outfile}`,
                ...files.map((file) => path.join(source, file)),
            ],
            { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }
        );
    compile(host, [
        "WorkerJob.cs",
        "WorkerProgram.cs",
        "DisplayLayout.cs",
        "DisplayWorker.cs",
        "NativeWindows.cs",
        "ConsentProtocol.cs",
    ]);
    return { host };
}

if (import.meta.main) {
    if (process.argv.length !== 2)
        throw new Error("No worker host build arguments are supported.");
    console.info(await buildWindowsWorkerHost());
}
