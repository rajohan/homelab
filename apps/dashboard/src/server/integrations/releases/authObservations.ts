import type { UpdateReport, UpdateSource } from "@homelab/contracts/updates";
import type { SQL } from "bun";
import * as v from "valibot";

import type { UpdateTarget } from "../updates/configuration";
import {
    releaseDeploymentRevision,
    type ReleaseDeploymentTarget,
} from "./deploymentConfiguration";
import {
    deploymentDigest,
    deploymentPlanSchema,
    deploymentProgressSchema,
} from "./deploymentProtocol";

/**
 * Show the newest observed Auth version, including a verified coordinated deployment.
 * @param options - Existing inventory sources and current deployment authorities.
 * @returns Public version observations without exposing receipts, account data or SSH configuration.
 */
export async function authReleaseObservations(options: {
    client: SQL;
    repository: string | undefined;
    sources: readonly UpdateSource[];
    targets: readonly ReleaseDeploymentTarget[];
    connections: readonly UpdateTarget[];
}) {
    const { client, repository } = options;
    if (!repository) return [];
    const reports = await client<{ key: string; value: UpdateReport }[]>`
        SELECT key,value FROM operation_snapshots WHERE key LIKE 'updates:%'`;
    const observations = new Map<
        string,
        {
            container: string;
            service?: string;
            name: string;
            version: string;
            image: string;
            capturedAt: string;
            stale: boolean;
        }[]
    >();
    for (const source of options.sources) {
        const report = reports.find(
            (entry) => entry.key === `updates:${source.id}`
        )?.value;
        if (!report) continue;
        observations.set(
            source.id,
            report.items
                .filter((item) =>
                    item.image?.startsWith(`ghcr.io/${repository.toLowerCase()}/auth:`)
                )
                .map((item) => ({
                    container: item.id,
                    name: item.name,
                    version:
                        item.installedVersion ??
                        item.image!.split(":")[1]?.split("@")[0] ??
                        "unknown",
                    image: item.image!,
                    capturedAt: report.capturedAt,
                    stale:
                        !report.complete ||
                        Date.parse(report.capturedAt) < Date.now() - 26 * 3_600_000,
                }))
        );
    }
    for (const target of options.targets) {
        const auth = target.auth;
        const source = options.connections.find(
            (entry) => entry.id === auth?.connection
        )?.source;
        if (!auth || !source || !options.sources.some((entry) => entry.id === source))
            continue;
        const configuration = releaseDeploymentRevision(target, options.connections);
        const rows = await client<
            { id: string; configuration: string; plan: unknown; receipt: unknown }[]
        >`
            SELECT id,configuration,plan,receipt FROM release_deployments
            WHERE target=${target.id} AND configuration=${configuration}
              AND receipt->'auth'->>'state'='succeeded'
            ORDER BY id`;
        for (const row of rows) {
            const plan = v.safeParse(deploymentPlanSchema, row.plan);
            const progress = v.safeParse(deploymentProgressSchema, row.receipt);
            if (!plan.success || !progress.success) continue;
            const { release, authExpected } = plan.output;
            const receipt = progress.output.auth;
            if (
                !authExpected ||
                release.repository !== repository ||
                receipt?.state !== "succeeded" ||
                receipt.phase !== "complete" ||
                !receipt.migrationStarted ||
                receipt.version !== release.version ||
                receipt.revision !== release.revision ||
                receipt.id !== row.id ||
                receipt.requestHash !==
                    deploymentDigest({
                        id: row.id,
                        target: auth,
                        release,
                        expected: authExpected,
                    })
            )
                continue;
            const timestamp = new Date(receipt.updatedAt * 1000);
            if (!Number.isFinite(timestamp.getTime())) continue;
            const capturedAt = timestamp.toISOString();
            const inventory = reports.find(
                (entry) => entry.key === `updates:${source}`
            )?.value;
            if (
                inventory?.complete &&
                inventory.coveredKinds.includes("container") &&
                Date.parse(inventory.capturedAt) >= timestamp.getTime()
            )
                continue;
            const image = release.images.find((entry) => entry.app === "auth")?.reference;
            if (
                !image ||
                auth.services.some((service) => {
                    const observed = receipt.containers?.[service.name];
                    return (
                        !observed?.running ||
                        observed.health !== "healthy" ||
                        observed.image !== image
                    );
                })
            )
                continue;
            for (const service of auth.services) {
                const key = JSON.stringify([auth.connection, auth.project, service.name]);
                const current = observations.get(source) ?? [];
                const matches = (item: (typeof current)[number]) =>
                    item.service === key ||
                    item.container ===
                        `docker:${authExpected.containers[service.name]?.id}` ||
                    item.container === `docker:${receipt.containers?.[service.name]?.id}`;
                if (
                    current.some(
                        (item) =>
                            matches(item) &&
                            Date.parse(item.capturedAt) >= timestamp.getTime()
                    )
                )
                    continue;
                observations.set(source, [
                    ...current.filter((item) => !matches(item)),
                    {
                        container: `docker:${receipt.containers![service.name]!.id}`,
                        service: key,
                        name: service.name,
                        version: release.version,
                        image,
                        capturedAt,
                        stale: Date.parse(capturedAt) < Date.now() - 26 * 3_600_000,
                    },
                ]);
            }
        }
    }
    return [...observations.values()]
        .flat()
        .map(
            ({ container: _container, service: _service, ...observation }) => observation
        );
}
