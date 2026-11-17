/** Maximum size accepted for an upstream native helper, both at build and load time. */
export const skillEngineMaxBytes = 128 * 1024 * 1024;

/**
 * Resolve Impeccable's documented sibling binary from its unchanged upstream pins.
 * @param entry - Verified original skill source package.
 * @param platform - Explicit release target OS.
 * @param architecture - Release target architecture; Windows ARM follows upstream's x64 fallback.
 * @returns The pinned engine artifact and installation paths, or null for a package without an engine.
 */
export function nativeSkillEngine(
    entry: { id: string; files: Record<string, string> },
    platform: string,
    architecture: string
) {
    if (entry.id !== "impeccable") return null;
    const directory = ".agents/skills/impeccable/scripts";
    const version = entry.files[`${directory}/VERSION`]?.trim();
    const os = platform === "win32" ? "windows" : platform;
    if (
        !version ||
        !/^\d+\.\d+\.\d+$/.test(version) ||
        !["linux", "darwin", "windows"].includes(os) ||
        !["x64", "arm64"].includes(architecture)
    )
        throw new Error("Unsupported native skill engine target or version.");
    const extension = os === "windows" ? ".exe" : "";
    const assetArchitecture = os === "windows" ? "x64" : architecture;
    const asset = `impeccable-${os}-${assetArchitecture}${extension}`;
    const records = (entry.files[`${directory}/engine-checksums.txt`] ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter((record) => record[0] === version && record[1] === asset);
    const sha256 = records[0]?.[2];
    if (records.length !== 1 || !sha256 || !/^[a-f0-9]{64}$/.test(sha256))
        throw new Error("The native skill engine has no unique pinned checksum.");
    return {
        version,
        sha256,
        launcher: `${directory}/impeccable`,
        path: `${directory}/bin/${os}-${architecture}/impeccable${extension}`,
        url: `https://github.com/pbakaus/impeccable/releases/download/engine-v${version}/${asset}`,
    };
}
