import path from "node:path";

import type {
    ApplicationInventory,
    ManagedApplication,
} from "@homelab/contracts/applications";
import type { SQL } from "bun";

import type { ApplicationTarget } from "./configuration";
import type { DockerDetail, DockerPort } from "./docker";
import { startupCodePaths } from "./startup";

export const applicationInventoryByteLimit = 8 * 1024 * 1024;
const containerByteLimit = 32 * 1024;
const hostByteLimit = 1024 * 1024;

/**
 * Capture the same database clock that stamps software snapshot mutations.
 * @param client - Dashboard database pool, outside the later fenced write transaction.
 * @returns UTC pre-read watermark preserving PostgreSQL microsecond precision.
 */
export async function readApplicationObservationTime(client: SQL): Promise<string> {
    const [row] = await client<{ time: string }[]>`
        SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`;
    if (!row) throw new Error("Application observation clock unavailable");
    return row.time;
}

function metadataBytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedInventory(inventory: ApplicationInventory): ApplicationInventory {
    const emptyHosts = inventory.hosts.map((host) => ({
        ...host,
        available: false,
        applications: [],
    }));
    let bytes = metadataBytes({ ...inventory, hosts: emptyHosts });
    return {
        ...inventory,
        hosts: inventory.hosts.map((host, index) => {
            const empty = emptyHosts[index];
            if (!empty) throw new Error("Missing inventory host envelope");
            if (host.applications.length > 200) return empty;
            let hostBytes = 2;
            for (const application of host.applications) {
                const size = metadataBytes(application);
                hostBytes += size + 1;
                if (size > containerByteLimit || hostBytes > hostByteLimit) return empty;
            }
            const additionalBytes = metadataBytes(host) - metadataBytes(empty);
            if (bytes + additionalBytes > applicationInventoryByteLimit) return empty;
            bytes += additionalBytes;
            return host;
        }),
    };
}

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
    return boundedInventory({
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
    });
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
    // Retain only a boolean. Startup arguments may contain credentials and must
    // never enter inventory snapshots, logs or the browser response.
    const startupPaths = startupCodePaths(
        detail.Config.Entrypoint,
        detail.Config.Cmd,
        detail.Config.WorkingDir
    );
    const application: ManagedApplication = {
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
            detail.State.Health?.Status ?? null,
            detail.State.StartedAt,
            detail.State.FinishedAt,
            detail.HostConfig ?? null,
        ]),
        namespaceParents: [
            ...new Set(
                Object.values(detail.HostConfig ?? {})
                    .filter((mode) => mode.startsWith("container:"))
                    .map((mode) => mode.slice("container:".length))
            ),
        ].toSorted(),
        networks: Object.keys(detail.NetworkSettings.Networks).toSorted(),
        mounts: detail.Mounts.map((mount) => ({
            type: mount.Type,
            source: mount.Source,
            destination: mount.Destination,
            readOnly: !mount.RW,
            startupCode: startupPaths.some(
                (item) =>
                    item === path.posix.normalize(mount.Destination) ||
                    item.startsWith(
                        path.posix.normalize(mount.Destination).replace(/\/$/, "") + "/"
                    )
            ),
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
    if (metadataBytes(application) > containerByteLimit)
        throw new Error("Container metadata exceeds its budget");
    return application;
}

/**
 * Collect each managed host independently without treating an unreachable daemon as empty/healthy.
 * @param targets - Explicit configured hosts and project allowlists.
 * @param connect - Worker-owned provider factory, replaceable with loopback fixtures.
 * @param signal - Job deadline and cancellation signal.
 * @param previous - Last successful identities retained when a configured host is unavailable.
 * @param hostTimeoutMs - Independent host budget, below the discovery job's overall deadline.
 * @param observationClock - Database clock captured before reads; absent clocks disable software reconciliation.
 * @returns One snapshot with per-host availability and only allowlisted applications.
 */
export async function collectApplications(
    targets: readonly ApplicationTarget[],
    connect: (target: ApplicationTarget) => DockerPort,
    signal: AbortSignal,
    previous?: ApplicationInventory | null,
    hostTimeoutMs = 20_000,
    observationClock?: () => Promise<string>
): Promise<ApplicationInventory> {
    signal.throwIfAborted();
    if (targets.length > 20) throw new Error("Host inventory exceeds its budget");
    const hosts = await Promise.all(
        targets.map(async (target) => {
            // Completion time cannot fence a software report published while Docker
            // reads are in flight. Preserve the conservative per-host start instead.
            const hostSignal = AbortSignal.any([
                signal,
                AbortSignal.timeout(hostTimeoutMs),
            ]);
            try {
                const observationStartedAt = await observationClock?.();
                hostSignal.throwIfAborted();
                const port = connect(target);
                const applications: ManagedApplication[] = [];
                const ids = await port.list(hostSignal);
                if (ids.length > 200)
                    throw new Error("Application inventory exceeds its budget");
                let hostBytes = 2;
                for (let offset = 0; offset < ids.length; offset += 4) {
                    hostSignal.throwIfAborted();
                    const rows = await Promise.all(
                        ids
                            .slice(offset, offset + 4)
                            .map(async (id) =>
                                mapDockerApplication(
                                    target,
                                    await port.inspect(id, hostSignal)
                                )
                            )
                    );
                    for (const row of rows) {
                        hostBytes += metadataBytes(row) + 1;
                        if (hostBytes > hostByteLimit)
                            throw new Error("Host metadata exceeds its budget");
                        applications.push(row);
                    }
                }
                return {
                    id: target.id,
                    label: target.label,
                    available: true,
                    ...(observationStartedAt ? { observationStartedAt } : {}),
                    applications,
                };
            } catch {
                signal.throwIfAborted();
                const applications =
                    previous?.hosts
                        .find((host) => host.id === target.id)
                        ?.applications.filter((item) =>
                            target.projects.includes(item.project)
                        ) ?? [];
                return {
                    id: target.id,
                    label: target.label,
                    available: false,
                    applications: [...applications],
                };
            }
        })
    );
    signal.throwIfAborted();
    // Apply the same byte limits to retained metadata and whole-host aggregate admission.
    return boundedInventory({ capturedAt: new Date().toISOString(), hosts });
}
