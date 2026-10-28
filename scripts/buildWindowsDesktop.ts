import { execFileSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the visible Windows connection manager and optional isolated native fixtures.
 * @param directory - Absolute caller-owned output directory; no installation or launch occurs.
 * @param tests - Also compile the non-distributed process/settings qualification executables.
 * @returns Fixed product and optional qualification paths.
 */
export async function buildWindowsDesktop(directory: string, tests = false) {
    if (
        process.platform !== "win32" ||
        process.arch !== "x64" ||
        !path.isAbsolute(directory)
    )
        throw new Error(
            "The desktop companion requires Windows x64 and absolute output."
        );
    const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    const source = path.join(root, "apps/mira/native/windows");
    const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!system || !path.isAbsolute(system))
        throw new Error("Windows SystemRoot is required.");
    const compiler = path.join(system, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
    await mkdir(directory, { recursive: true });
    const desktop = path.join(directory, "mira-computer-desktop.exe");
    const shared = [
        "WorkerJob.cs",
        "DesktopSettings.cs",
        "DesktopSession.cs",
        "InstallationLease.cs",
        "InstallationProtocol.cs",
        "ConsentProtocol.cs",
        "DesktopButton.cs",
        "DesktopForm.cs",
    ];
    const common = [
        "/nologo",
        "/platform:x64",
        "/warnaserror+",
        "/optimize+",
        `/win32manifest:${path.join(source, "app.manifest")}`,
        `/win32icon:${path.join(root, "packages/ui/src/assets/rajohan.ico")}`,
        "/reference:System.Windows.Forms.dll",
        "/reference:System.Drawing.dll",
        "/reference:System.Web.Extensions.dll",
    ];
    const compile = (file: string, sources: string[], gui = false) =>
        execFileSync(
            compiler,
            [
                ...common,
                gui ? "/target:winexe" : "/target:exe",
                `/out:${file}`,
                ...sources.map((name) => path.join(source, name)),
            ],
            { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }
        );
    compile(desktop, [...shared, "DesktopProgram.cs"], true);
    const checks = tests ? path.join(directory, "desktop-tests.exe") : undefined;
    if (checks) {
        compile(checks, [...shared, "tests/DesktopTests.cs"]);
        const fixture = path.join(directory, "fixture");
        await mkdir(fixture);
        compile(path.join(fixture, "mira-computer.exe"), [
            "WorkerJob.cs",
            "tests/DesktopFixture.cs",
        ]);
    }
    return { desktop, checks };
}

if (import.meta.main) {
    if (process.argv.length !== 2)
        throw new Error("No desktop build arguments are supported.");
    const output = fileURLToPath(
        new URL("../apps/mira/dist/windows-desktop", import.meta.url)
    );
    console.info(await buildWindowsDesktop(output));
}
