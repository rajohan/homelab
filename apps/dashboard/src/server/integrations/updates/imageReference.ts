export interface PublicImageReference {
    readonly origin: string;
    readonly authOrigin: string;
    readonly authService: string;
    readonly repository: string;
    readonly tag: string;
    readonly prefix: string;
}

/**
 * Separate an installed digest from its public registry tracking channel.
 * @param image - Configured image, optionally pinned by digest.
 * @param tag - Operator-selected tracking tag, never a registry or URL.
 * @returns Fixed-origin reference or null for unsupported images.
 */
export function publicImageReference(
    image: string,
    tag?: string
): PublicImageReference | null {
    const parts = image.split("@");
    const reference = parts[0];
    if (
        !reference ||
        parts.length > 2 ||
        (parts[1] !== undefined && !/^sha256:[a-f0-9]{64}$/.test(parts[1]))
    )
        return null;
    if (tag !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))
        return null;
    const slash = reference.indexOf("/");
    const first = reference.slice(0, slash);
    const explicitRegistry =
        slash !== -1 &&
        (first.includes(".") ||
            first.includes(":") ||
            first === "localhost" ||
            first !== first.toLowerCase());
    const registry = explicitRegistry ? first : "docker.io";
    const name = explicitRegistry ? reference.slice(slash + 1) : reference;
    const dockerHub =
        registry === "docker.io" ||
        registry === "registry-1.docker.io" ||
        registry === "index.docker.io";
    if (!dockerHub && registry !== "ghcr.io") return null;
    const fields =
        /^(?<repository>[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?$/.exec(
            name
        )?.groups;
    if (!fields?.repository) return null;
    const repository =
        dockerHub && !fields.repository.includes("/")
            ? "library/" + fields.repository
            : fields.repository;
    return {
        origin: dockerHub ? "https://registry-1.docker.io" : "https://ghcr.io",
        authOrigin: dockerHub ? "https://auth.docker.io/token" : "https://ghcr.io/token",
        authService: dockerHub ? "registry.docker.io" : "ghcr.io",
        repository,
        tag: tag ?? fields.tag ?? "latest",
        prefix: `${dockerHub ? "docker.io" : "ghcr.io"}/${repository}`,
    };
}

/**
 * Recognize stable image versions without treating distro flavors as prereleases.
 * @param tag - Registry tag such as v1.2.3 or 1.2.3-alpine.
 * @returns Comparable version and exact flavor, or null for other tracking schemes.
 */
export function imageVersionTag(
    tag: string
): { readonly version: string; readonly flavor: string; readonly prefix: string } | null {
    const match =
        /^(v?)(\d+\.\d+\.\d+)(-(?:alpine|bookworm|bullseye|trixie|slim)(?:[\d.-]*))?$/.exec(
            tag
        );
    return match?.[2]
        ? { version: match[2], flavor: match[3] ?? "", prefix: match[1] ?? "" }
        : null;
}
