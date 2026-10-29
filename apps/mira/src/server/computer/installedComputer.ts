import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { computerEnvironment } from "../config/environment";
import { computerOrigin } from "./companion";
import type { ComputerConsentHost } from "./companionConsent";
import { ComputerLocalConsentHost } from "./localConsentHost";
import { openWindowsComputerProcess } from "./process";
import { assertLocalWindowsComputerDrive } from "./windowsDrive";

/**
 * Validate the fixed sibling executables before an installed companion connects.
 * @param executable - Trusted process executable, never a server-supplied path.
 * @returns The canonical local package directory; links, missing files and renamed clients are refused.
 */
export async function readComputerPackage(executable: string): Promise<string> {
    if (!path.isAbsolute(executable) || executable.startsWith(String.raw`\\`))
        throw new Error(
            "Run the installed Windows companion from its complete local package."
        );
    if (process.platform === "win32") await assertLocalWindowsComputerDrive(executable);
    // Inspect the supplied path as well as its canonical form: casing and 8.3 spelling
    // are valid on Windows, but a reparse/symlink anywhere in the path is not.
    for (let entry = executable; ; entry = path.dirname(entry)) {
        const metadata = await lstat(entry);
        if (metadata.isSymbolicLink())
            throw new Error("The computer package cannot use linked paths.");
        if (path.dirname(entry) === entry) break;
    }
    const canonical = await realpath(executable);
    const basename = path.basename(canonical);
    if (
        (process.platform === "win32" ? basename.toLowerCase() : basename) !==
        "mira-computer.exe"
    )
        throw new Error(
            "Run the installed Windows companion from its complete local package."
        );
    const directory = path.dirname(canonical);
    for (const name of [
        "mira-computer-desktop.exe",
        "mira-computer.exe",
        "mira-computer-consent.exe",
        "mira-computer-worker-host.exe",
        "mira-computer-worker.exe",
        "mira-window-capture.exe",
    ]) {
        const file = path.join(directory, name);
        const metadata = await lstat(file);
        if (!metadata.isFile() || metadata.isSymbolicLink())
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
