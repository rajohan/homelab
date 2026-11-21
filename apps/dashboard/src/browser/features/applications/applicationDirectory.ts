import type { ManagedApplication } from "@homelab/contracts/applications";
import type { ApplicationMetric } from "@homelab/contracts/infrastructure";

type Identity = Pick<ApplicationMetric, "host" | "project" | "name">;

export interface ApplicationEntry extends Identity {
    readonly id: string;
    readonly metric?: ApplicationMetric;
    readonly container?: ManagedApplication;
}

const serviceKey = (app: Identity) => JSON.stringify([app.host, app.project, app.name]);

/** Join a monitoring sample only to a unique container on the same host, project and service.
 * @param metrics - Expected applications, including native workloads and missing samples.
 * @param containers - Worker-discovered containers with their original action identities.
 * @returns Every discovered or expected entry, including replicas without a one-to-one match.
 */
export function applicationDirectory(
    metrics: readonly ApplicationMetric[],
    containers: readonly ManagedApplication[]
): ApplicationEntry[] {
    const samples = Map.groupBy(
        metrics.filter((metric) => metric.resourceSource !== "native"),
        serviceKey
    );
    const candidates = Map.groupBy(containers, serviceKey);
    const paired = new Set<string>();
    const entries: ApplicationEntry[] = metrics.map((metric) => {
        const key = serviceKey(metric);
        const matches = candidates.get(key);
        const container =
            metric.resourceSource !== "native" &&
            samples.get(key)?.length === 1 &&
            matches?.length === 1
                ? matches[0]
                : undefined;
        if (container) paired.add(container.id);
        return {
            id: "metric:" + metric.id,
            host: metric.host,
            project: metric.project,
            name: metric.name,
            metric,
            ...(container && { container }),
        };
    });
    for (const container of containers) {
        if (!paired.has(container.id))
            entries.push({
                id: "container:" + container.id,
                host: container.host,
                project: container.project,
                name: container.name,
                container,
            });
    }
    return entries;
}
