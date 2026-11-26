import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwind from "bun-plugin-tailwind";

export const windowsDialogExecutables = {
    consent: "mira-computer-consent.exe",
    desktop: "mira-computer-desktop.exe",
} as const;

const sources = {
    consent: [
        "NativeWindows.cs",
        "InstallationLease.cs",
        "DisplayLayout.cs",
        "ConsentProtocol.cs",
        "DesktopAppearance.cs",
        "DesktopButton.cs",
        "MiraWindow.cs",
        "ConsentForm.cs",
        "ConsentRecoveryView.cs",
        "Program.cs",
    ],
    desktop: [
        "WorkerJob.cs",
        "DesktopSettings.cs",
        "DesktopSession.cs",
        "DesktopUpdateArtifact.cs",
        "DesktopUpdateSession.cs",
        "InstallationLease.cs",
        "InstallationProtocol.cs",
        "ConsentProtocol.cs",
        "DesktopAppearance.cs",
        "DesktopButton.cs",
        "DesktopStateView.cs",
        "DesktopUpdateDialog.cs",
        "MiraWindow.cs",
        "MiraNotice.cs",
        "DesktopConnection.cs",
        "DesktopBridge.cs",
        "DesktopWebView.cs",
        "DesktopForm.cs",
        "DesktopProgram.cs",
    ],
} as const;

/** Build the selected dialog hosts with one verified SDK and a single shared UI bundle.
 * @param directory - Absolute build directory for the executables and WebView2 runtime files.
 * @param targets - Hosts to compile; the release and CodeQL build both together.
 * @returns Completion after all requested executables have been compiled.
 */
export async function buildWindowsDialogHosts(
    directory: string,
    targets: readonly (keyof typeof windowsDialogExecutables)[] = ["consent", "desktop"]
): Promise<void> {
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
    execFileSync(
        path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            path.join(root, "scripts/setupWebView.ps1"),
            "-Destination",
            directory,
        ],
        {
            windowsHide: true,
            timeout: 120_000,
            maxBuffer: 64 * 1024,
            env: {
                ...process.env,
                PSModulePath: path.join(
                    system,
                    "System32/WindowsPowerShell/v1.0/Modules"
                ),
            },
        }
    );
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
        `/reference:${path.join(directory, "Microsoft.Web.WebView2.Core.dll")}`,
        `/reference:${path.join(directory, "Microsoft.Web.WebView2.WinForms.dll")}`,
    ];
    const ui = path.join(root, "apps/dashboard/src/browser/desktopDialog");
    const assets = await mkdtemp(path.join(tmpdir(), "homelab-desktop-ui-"));
    try {
        const bundle = await Bun.build({
            entrypoints: [path.join(ui, "main.tsx"), path.join(ui, "dialog.css")],
            outdir: assets,
            target: "browser",
            minify: true,
            env: "disable",
            define: { "process.env.NODE_ENV": JSON.stringify("production") },
            plugins: [tailwind],
        });
        if (!bundle.success)
            throw new AggregateError(bundle.logs, "Desktop dialog build failed.");
        for (const target of targets) {
            execFileSync(
                compiler,
                [
                    ...common,
                    "/target:winexe",
                    `/out:${path.join(directory, windowsDialogExecutables[target])}`,
                    `/resource:${path.join(ui, "index.html")},index.html`,
                    ...["main.js", "dialog.css"].map(
                        (name) => `/resource:${path.join(assets, name)},${name}`
                    ),
                    ...["DesktopDialogView.cs", ...sources[target]].map((name) =>
                        path.join(source, name)
                    ),
                ],
                { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 }
            );
        }
    } finally {
        await rm(assets, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    if (process.argv.length !== 2)
        throw new Error("No dialog build arguments are supported.");
    await buildWindowsDialogHosts(
        fileURLToPath(new URL("../apps/mira/dist/computer/windows-x64", import.meta.url))
    );
}
