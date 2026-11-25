import { execFileSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the Windows consent surface using the OS .NET Framework compiler without package downloads.
 * @param outputRoot - Optional isolated output directory; the builder never removes existing files.
 * @returns Path to the GUI host.
 */
export async function buildWindowsConsent(outputRoot?: string) {
    if (process.platform !== "win32")
        throw new Error("The Windows consent host must be built on Windows.");
    const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    const source = path.join(root, "apps/mira/native/windows");
    const directory =
        outputRoot ?? path.join(root, "apps/mira/dist/computer/windows-x64");
    await mkdir(directory, { recursive: true });
    const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!system || !path.isAbsolute(system))
        throw new Error("Windows SystemRoot is required.");
    const compiler = path.join(system, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
    const host = path.join(directory, "mira-computer-consent.exe");
    const common = [
        "/nologo",
        "/platform:x64",
        `/win32icon:${path.join(root, "packages/ui/src/assets/rajohan.ico")}`,
        "/warnaserror+",
        "/optimize+",
        `/win32manifest:${path.join(source, "app.manifest")}`,
        "/reference:System.Windows.Forms.dll",
        "/reference:System.Drawing.dll",
        "/reference:System.Web.Extensions.dll",
        ...[
            "NativeWindows.cs",
            "DisplayLayout.cs",
            "ConsentProtocol.cs",
            "MiraWindow.cs",
            "ConsentForm.cs",
            "Program.cs",
        ].map((file) => path.join(source, file)),
    ];
    // Instrumented CodeQL builds can exceed 30 seconds on a cold Windows runner.
    execFileSync(compiler, ["/target:winexe", `/out:${host}`, ...common], {
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 64 * 1024,
    });
    return { host };
}

if (import.meta.main) {
    if (process.argv.length !== 2)
        throw new Error("Usage: bun --no-env-file scripts/buildWindowsConsent.ts");
    console.info(await buildWindowsConsent());
}
