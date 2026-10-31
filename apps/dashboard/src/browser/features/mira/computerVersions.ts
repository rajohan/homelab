/**
 * Compare a reported stable companion version with the verified Windows release.
 * @param installed - Last reported version; unknown and preview builds are not upgrade candidates.
 * @param available - Verified stable release version.
 * @returns Whether the installed stable version is older than the available release.
 */
export function olderComputerVersion(
    installed: string | null,
    available: string
): boolean {
    if (!installed || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(installed)) return false;
    const current = installed.split(".").map(Number);
    const latest = available.split(".").map(Number);
    for (let index = 0; index < 3; index++) {
        if (current[index] !== latest[index]) return current[index]! < latest[index]!;
    }
    return false;
}
