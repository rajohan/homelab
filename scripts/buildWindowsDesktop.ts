import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    buildWindowsDialogHosts,
    windowsDialogExecutables,
} from "./buildWindowsDialogHost";

/**
 * Build the shared-dashboard Windows shell.
 * @param directory - Absolute caller-owned output directory; no installation or launch occurs.
 * @returns Path to the Windows desktop executable.
 */
export async function buildWindowsDesktop(directory: string) {
    await buildWindowsDialogHosts(directory, ["desktop"]);
    return { desktop: path.join(directory, windowsDialogExecutables.desktop) };
}

if (import.meta.main) {
    if (process.argv.length !== 2)
        throw new Error("No desktop build arguments are supported.");
    const output = fileURLToPath(
        new URL("../apps/mira/dist/windows-desktop", import.meta.url)
    );
    console.info(await buildWindowsDesktop(output));
}
