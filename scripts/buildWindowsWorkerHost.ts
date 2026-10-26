import { execFileSync } from "node:child_process";
import { cp, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compile the fixed Windows worker supervisor and optional harmless ownership fixtures.
 * @param outputRoot - Caller-owned output directory; existing content is never removed.
 * @param tests - Compile non-distributed child/grandchild fixtures in a separate directory.
 * @returns The supervisor path and optional native test/fixture paths.
 */
export async function buildWindowsWorkerHost(outputRoot?: string, tests = false) {
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
        "/warnaserror+",
        "/optimize+",
        "/target:exe",
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
    compile(host, ["WorkerJob.cs", "WorkerProgram.cs"]);
    if (!tests) return { host };
    const fixtures = path.join(outputRoot, "qualification");
    await mkdir(fixtures, { recursive: true });
    const fixtureHost = path.join(fixtures, path.basename(host));
    await cp(host, fixtureHost);
    compile(path.join(fixtures, "mira-computer-worker.exe"), ["tests/WorkerFixture.cs"]);
    const checks = path.join(fixtures, "mira-computer-worker-tests.exe");
    compile(checks, ["tests/WorkerTests.cs"]);
    return { host, fixtureHost, checks };
}

if (import.meta.main) {
    if (process.argv.length !== 2)
        throw new Error("No worker host build arguments are supported.");
    console.info(await buildWindowsWorkerHost());
}
