import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    buildWindowsDialogHosts,
    windowsDialogExecutables,
} from "./buildWindowsDialogHost";

/**
 * Build the Windows consent surface with the shared local dialog.
 * @param outputRoot - Optional isolated output directory; the builder never removes existing files.
 * @returns Path to the GUI host.
 */
export async function buildWindowsConsent(outputRoot?: string) {
    const directory = path.resolve(
        outputRoot ??
            fileURLToPath(
                new URL("../apps/mira/dist/computer/windows-x64", import.meta.url)
            )
    );
    await buildWindowsDialogHosts(directory, ["consent"]);
    return { host: path.join(directory, windowsDialogExecutables.consent) };
}

if (import.meta.main) {
    if (process.argv.length !== 2)
        throw new Error("Usage: bun --no-env-file scripts/buildWindowsConsent.ts");
    console.info(await buildWindowsConsent());
}
