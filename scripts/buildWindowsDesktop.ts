import { fileURLToPath } from "node:url";

import { buildWindowsDialogHost } from "./buildWindowsDialogHost";

/**
 * Build the shared-dashboard Windows shell.
 * @param directory - Absolute caller-owned output directory; no installation or launch occurs.
 * @returns Path to the Windows desktop executable.
 */
export async function buildWindowsDesktop(directory: string) {
    const shared = [
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
    ];
    return {
        desktop: await buildWindowsDialogHost(
            directory,
            "mira-computer-desktop.exe",
            shared
        ),
    };
}

if (import.meta.main) {
    if (process.argv.length !== 2)
        throw new Error("No desktop build arguments are supported.");
    const output = fileURLToPath(
        new URL("../apps/mira/dist/windows-desktop", import.meta.url)
    );
    console.info(await buildWindowsDesktop(output));
}
