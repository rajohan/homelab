interface HostRecipe {
    readonly source: string;
    readonly host: string;
    readonly driver: { readonly kind: string };
}

interface SourceBinding {
    readonly id: string;
    readonly updateSources?: readonly string[] | undefined;
}

/**
 * Close explicit source bindings and same-SSH-host Docker aliases to a fixed point.
 * @param roots - Sources whose physical host equivalence must be resolved.
 * @param targets - Deployment-owned recipes; non-Docker host edges never imply aliases.
 * @param applications - Explicit lifecycle source groups, including read-only aliases.
 * @returns Unique sorted sources, independent of recipe order and binding cycles.
 */
export function boundHostSources(
    roots: readonly string[],
    targets: readonly HostRecipe[],
    applications: readonly SourceBinding[]
): string[] {
    const sources = new Set(roots);
    const hosts = new Map<string, string[]>();
    for (const target of targets) {
        if (target.driver.kind !== "docker") continue;
        const host = target.host.toLowerCase();
        const bound = hosts.get(host) ?? [];
        bound.push(target.source);
        hosts.set(host, bound);
    }
    const bindings = [
        ...hosts.values(),
        ...applications.map(
            (application) => application.updateSources ?? [application.id]
        ),
    ];
    let previousSize: number;
    do {
        previousSize = sources.size;
        for (const bound of bindings)
            if (bound.some((source) => sources.has(source)))
                for (const source of bound) sources.add(source);
    } while (sources.size !== previousSize);
    return [...sources].toSorted();
}
