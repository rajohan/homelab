import type {
    ApplicationInventory,
    ManagedApplication,
} from "@homelab/contracts/applications";

import type { ApplicationTarget } from "./configuration";
import type { DockerDetail, DockerPort } from "./docker";

/**
 * Reapply today's allowlist to snapshots written by an earlier configuration.
 * @param inventory - Last stored snapshot, possibly from before a configuration change.
 * @param targets - Currently configured hosts and project names.
 * @returns Only metadata still authorized by the current deployment.
 */
export function filterApplicationInventory(
    inventory: ApplicationInventory | null,
    targets: readonly ApplicationTarget[]
): ApplicationInventory | null {
    if (!inventory) return null;
    return {
        ...inventory,
        hosts: inventory.hosts.flatMap((host) => {
            const target = targets.find((item) => item.id === host.id);
            return target
                ? [
                      {
                          ...host,
                          label: target.label,
                          applications: host.applications.filter((item) =>
                              target.projects.includes(item.project)
                          ),
                      },
                  ]
                : [];
        }),
    };
}

/**
 * Hash exact observed container identities and states for stale-intent rejection.
 * @param values - Canonical identity/state tuples from a trusted provider adapter.
 * @returns A stable digest independent of collection time.
 */
export function applicationRevision(values: readonly unknown[]): string {
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(values)).digest("hex");
}

/**
 * Select safe metadata explicitly; environment variables, labels and log bodies are excluded.
 * @param target - The configured host identity.
 * @param detail - Validated Docker inspect response.
 * @returns Browser-safe metadata with a current-state revision.
 */
export function mapDockerApplication(
    target: ApplicationTarget,
    detail: DockerDetail
): ManagedApplication {
    return {
        id: `${target.id}:${detail.Id}`,
        host: target.id,
        containerId: detail.Id,
        name:
            detail.Config.Labels?.["com.docker.compose.service"] ??
            detail.Name.replace(/^\//, ""),
        containerName: detail.Name.replace(/^\//, ""),
        project: detail.Config.Labels?.["com.docker.compose.project"] ?? "",
        image: detail.Config.Image,
        imageId: detail.Image,
        state: detail.State.Status,
        health: detail.State.Health?.Status ?? null,
        startedAt: detail.State.StartedAt,
        revision: applicationRevision([
            detail.Id,
            detail.Image,
            detail.State.Status,
            detail.State.StartedAt,
            detail.State.FinishedAt,
        ]),
        networks: Object.keys(detail.NetworkSettings.Networks).toSorted(),
        mounts: detail.Mounts.map((mount) => ({
            type: mount.Type,
            source: mount.Source,
            destination: mount.Destination,
            readOnly: !mount.RW,
        })),
        ports: Object.entries(detail.NetworkSettings.Ports ?? {}).flatMap(
            ([container, bindings]) =>
                (bindings ?? []).map((binding) => ({
                    container,
                    hostAddress: binding.HostIp,
                    hostPort: binding.HostPort,
                }))
        ),
    };
}

/**
 * Collect each managed host independently without treating an unreachable daemon as empty/healthy.
 * @param targets - Explicit configured hosts and project allowlists.
 * @param connect - Worker-owned provider factory, replaceable with loopback fixtures.
 * @param signal - Job deadline and cancellation signal.
 * @param previous - Last successful identities retained when a configured host is unavailable.
 * @returns One snapshot with per-host availability and only allowlisted applications.
 */
export async function collectApplications(
    targets: readonly ApplicationTarget[],
    connect: (target: ApplicationTarget) => DockerPort,
    signal: AbortSignal,
    previous?: ApplicationInventory | null
): Promise<ApplicationInventory> {
    const hosts = [];
    for (const target of targets) {
        try {
            const port = connect(target);
            const applications: ManagedApplication[] = [];
            const ids = await port.list(signal);
            for (let offset = 0; offset < ids.length; offset += 4) {
                const rows = await Promise.all(
                    ids
                        .slice(offset, offset + 4)
                        .map(async (id) =>
                            mapDockerApplication(target, await port.inspect(id, signal))
                        )
                );
                applications.push(...rows);
            }
            hosts.push({
                id: target.id,
                label: target.label,
                available: true,
                applications,
            });
        } catch {
            signal.throwIfAborted();
            const applications =
                previous?.hosts
                    .find((host) => host.id === target.id)
                    ?.applications.filter((item) =>
                        target.projects.includes(item.project)
                    ) ?? [];
            hosts.push({
                id: target.id,
                label: target.label,
                available: false,
                applications: [...applications],
            });
        }
    }
    return { capturedAt: new Date().toISOString(), hosts };
}
