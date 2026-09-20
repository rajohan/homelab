import type { UpdateItem } from "@homelab/contracts/updates";

/**
 * Format a software version without expanding immutable image digests across table rows.
 * @param item - Observed software and resolved candidate.
 * @param side - The installed or available version to display.
 * @returns A readable tag/version, or a shortened digest for opaque images.
 */
export function updateVersion(item: UpdateItem, side: "installed" | "available"): string {
    const version = side === "installed" ? item.installed : item.available;
    if (item.kind !== "container") return version ?? "Not checked";
    const reference = side === "installed" ? item.image : item.availableImage;
    const release = side === "installed" ? item.installedVersion : item.availableVersion;
    const name = reference?.split("@")[0]?.split("/").at(-1);
    const tag = name?.includes(":") ? name.split(":").at(-1) : undefined;
    const identity = reference?.split("@")[1] ?? version;
    const short = identity?.startsWith("sha256:") ? identity.slice(0, 19) : identity;
    if (tag && release && tag !== release && tag !== `v${release}`)
        return `${tag} (${release})`;
    if (tag) return `${tag}${short ? ` · ${short}` : ""}`;
    return release ?? short ?? "Not checked";
}
