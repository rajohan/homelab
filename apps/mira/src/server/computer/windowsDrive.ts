import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { computerEnvironment } from "../config/environment";

/**
 * Reject UNC, mapped remote drives and unknown volumes before launching packaged native code.
 * @param executable - Host-owned absolute Windows executable path, including ordinary casing or short names.
 * @param inspect - OS drive-type probe; injectable only for isolated volume-policy tests.
 * @returns Completion only for a confirmed local drive; probe failures deny startup.
 */
export async function assertLocalWindowsComputerDrive(
    executable: string,
    inspect: (root: string) => Promise<number> = windowsDriveType
): Promise<void> {
    const root = path.win32.parse(executable).root;
    if (!/^[a-z]:\\$/i.test(root))
        throw new Error("The computer package must use a local Windows drive.");
    const type = await inspect(root);
    if (![2, 3, 5, 6].includes(type))
        throw new Error("Network or unknown drives cannot contain the computer package.");
}

async function windowsDriveType(root: string): Promise<number> {
    const environment = computerEnvironment();
    const system = environment.SystemRoot ?? environment.SYSTEMROOT;
    if (!system || !path.win32.isAbsolute(system) || system.startsWith(String.raw`\\`))
        throw new Error("Windows SystemRoot is required for local drive validation.");
    // Fixed OS command and bounded output; the validated drive root is data, never script text.
    const result = await promisify(execFile)(
        path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Write([int]([System.IO.DriveInfo]::new($env:MIRA_COMPUTER_VOLUME_ROOT)).DriveType)",
        ],
        {
            cwd: system,
            env: { ...environment, MIRA_COMPUTER_VOLUME_ROOT: root },
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 1024,
            encoding: "utf8",
        }
    );
    if (!/^[0-6]$/.test(result.stdout))
        throw new Error("Windows drive type was not confirmed.");
    return Number(result.stdout);
}
