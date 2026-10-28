import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { computerEnvironment } from "../config/environment";
import { computerOrigin } from "./companion";
import type { ComputerConsentHost } from "./companionConsent";
import { ComputerLocalConsentHost } from "./localConsentHost";
import { openWindowsComputerProcess } from "./process";

/**
 * Validate the fixed sibling executables before an installed companion connects.
 * @param executable - Trusted process executable, never a server-supplied path.
 * @returns The canonical local package directory; links, missing files and renamed clients are refused.
 */
export async function readComputerPackage(executable: string): Promise<string> {
    if (
        !path.isAbsolute(executable) ||
        executable.startsWith(String.raw`\\`) ||
        path.basename(executable) !== "mira-computer.exe" ||
        (await realpath(executable)) !== executable
    )
        throw new Error(
            "Run the installed Windows companion from its complete local package."
        );
    const directory = path.dirname(executable);
    for (const name of [
        "mira-computer.exe",
        "mira-computer-consent.exe",
        "mira-computer-worker-host.exe",
        "mira-computer-worker.exe",
    ]) {
        const file = path.join(directory, name);
        const metadata = await lstat(file);
        if (!metadata.isFile() || (await realpath(file)) !== file)
            throw new Error("The computer package requires ordinary local executables.");
    }
    return directory;
}

/**
 * Bind the installed Windows consent surface and supervised driver without opening either.
 * @param origin - Canonical private server displayed by every local consent prompt.
 * @param executable - Trusted process executable; fixed siblings are required before connecting.
 * @returns A fresh single-attempt host factory; no remote request can override its launch paths.
 */
export async function installedComputerHost(
    origin: string,
    executable: string
): Promise<() => ComputerConsentHost> {
    const server = computerOrigin(origin);
    const directory = await readComputerPackage(executable);
    const environment = computerEnvironment();
    return () =>
        new ComputerLocalConsentHost(
            {
                origin: server,
                command: path.join(directory, "mira-computer-consent.exe"),
                args: [],
                cwd: directory,
                environment,
                windowsHide: false,
            },
            (target, signal) =>
                openWindowsComputerProcess(target, { directory, environment, signal })
        );
}
