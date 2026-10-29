import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compile the window-only capture candidate with the installed Windows SDK and Visual C++ tools.
 * @param directory - Absolute caller-owned build output, separate from distributed release files.
 * @returns The native qualification executable; no compiler or package is downloaded.
 */
export async function buildWindowsCapture(directory: string): Promise<string> {
    if (
        process.platform !== "win32" ||
        process.arch !== "x64" ||
        !path.isAbsolute(directory)
    )
        throw new Error("Window capture qualification requires Windows x64 output.");
    const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    const programs = process.env["ProgramFiles(x86)"];
    if (!system || !programs || !path.isAbsolute(system) || !path.isAbsolute(programs))
        throw new Error("Windows compiler discovery is unavailable.");
    const installation = execFileSync(
        path.join(programs, "Microsoft Visual Studio/Installer/vswhere.exe"),
        [
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 }
    ).trim();
    if (!path.isAbsolute(installation)) throw new Error("Visual C++ tools are missing.");
    await mkdir(directory, { recursive: true });
    directory = await realpath(directory);
    const developer = path.join(installation, "Common7/Tools/VsDevCmd.bat");
    // These paths cross cmd.exe solely to initialize the installed compiler environment.
    for (const value of [root, directory, developer, system])
        if (/["%!\r\n&|<>^]/.test(value)) throw new Error("Unsupported compiler path.");
    const executable = path.join(directory, "mira-window-capture.exe");
    const response = path.join(directory, "capture.rsp");
    await writeFile(
        response,
        [
            "/nologo",
            "/std:c++20",
            "/EHsc",
            "/W4",
            "/WX",
            "/O2",
            "/MT",
            "/permissive-",
            "/guard:cf",
            "/sdl",
            "/DUNICODE",
            "/D_UNICODE",
            "/DNOMINMAX",
            `/Fo:${quoted(path.join(directory, "capture.obj"))}`,
            `/Fe:${quoted(executable)}`,
            quoted(path.join(root, "apps/mira/native/windows-capture/Capture.cpp")),
            "/link",
            "/SUBSYSTEM:CONSOLE",
            "/DYNAMICBASE",
            "/NXCOMPAT",
            "/HIGHENTROPYVA",
            "d3d11.lib",
            "dwmapi.lib",
            "dxgi.lib",
            "windowsapp.lib",
            "windowscodecs.lib",
            "ole32.lib",
            "user32.lib",
        ].join(" ")
    );
    await writeFile(
        path.join(directory, "capture-build.cmd"),
        [
            "@echo off",
            `call "${developer}" -no_logo -arch=amd64 -host_arch=amd64`,
            "if errorlevel 1 exit /b %errorlevel%",
            `cl.exe @"${response}"`,
            "exit /b %errorlevel%",
        ].join("\r\n")
    );
    execFileSync(
        path.join(system, "System32/cmd.exe"),
        ["/d", "/c", "capture-build.cmd"],
        { cwd: directory, windowsHide: true, timeout: 120_000, maxBuffer: 128 * 1024 }
    );
    return executable;
}

function quoted(value: string) {
    return `"${value}"`;
}

if (import.meta.main) {
    const [directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length > 0)
        throw new Error("Provide one absolute build directory.");
    console.info(await buildWindowsCapture(directory));
}
