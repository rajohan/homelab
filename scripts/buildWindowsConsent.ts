import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWindowsDialogHost } from "./buildWindowsDialogHost";

/**
 * Build the Windows consent surface with the shared local dialog.
 * @param outputRoot - Optional isolated output directory; the builder never removes existing files.
 * @returns Path to the GUI host.
 */
export async function buildWindowsConsent(outputRoot?: string) {
    const directory =
        outputRoot ??
        fileURLToPath(new URL("../apps/mira/dist/computer/windows-x64", import.meta.url));
    return {
        host: await buildWindowsDialogHost(
            path.resolve(directory),
            "mira-computer-consent.exe",
            [
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
            ]
        ),
    };
}

if (import.meta.main) {
    if (process.argv.length !== 2)
        throw new Error("Usage: bun --no-env-file scripts/buildWindowsConsent.ts");
    console.info(await buildWindowsConsent());
}
