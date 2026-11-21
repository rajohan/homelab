import type { FilesystemMetric } from "@homelab/contracts/infrastructure";

/** Read the measured root filesystem for exactly one exporter identity.
 * @param host - The host's node-exporter label.
 * @param filesystems - The current infrastructure filesystem observations.
 * @returns The root mount or undefined when that host has no root measurement.
 */
export function systemFilesystem(
    host: string | null,
    filesystems: readonly FilesystemMetric[]
) {
    return filesystems.find((volume) => volume.host === host && volume.mount === "/");
}
