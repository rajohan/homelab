import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import type { UpdateTarget } from "../updates/configuration";
import { updateResourceKeys } from "../updates/configuration";
import {
    deploymentHosts,
    releaseDeploymentRevision,
    type ReleaseDeploymentTarget,
} from "./deploymentConfiguration";
import {
    deploymentDigest,
    deploymentHost,
    deploymentObservationSchema,
    deploymentPlanSchema,
    type DeploymentHost,
    type DeploymentObservation,
    type DeploymentRelease,
} from "./deploymentProtocol";
import { readHomelabRelease } from "./read";

/**
 * Select only independently verified core and browser images for a configured deployment.
 * @param release - Current official release read with matching workflow evidence.
 * @param target - Explicit services and optional managed browser runtime.
 * @returns The frozen minimal image manifest, refusing incomplete publications.
 */
export function deploymentRelease(
    release: Awaited<ReturnType<typeof readHomelabRelease>>,
    target: ReleaseDeploymentTarget
) {
    if (
        !release.verified ||
        (target.browserConfigFile && !release.browser) ||
        (target.localCodeConfigFile && !release.code)
    )
        throw new Error("A complete verified release is required");
    const images = [
        ...release.images,
        ...(target.browserConfigFile ? release.browser!.images : []),
        ...(target.localCodeConfigFile ? release.code!.images : []),
    ];
    if (
        deploymentHosts(target)
            .flatMap((entry) => entry.services)
            .some((service) => !images.some((image) => image.app === service.app))
    )
        throw new Error("Required release images are unavailable");
    return {
        ...(release.dashboardSchema ? { dashboardSchema: release.dashboardSchema } : {}),
        ...(release.authSchema ? { authSchema: release.authSchema } : {}),
        repository: release.repository,
        version: release.version,
        revision: release.revision,
        images,
    };
}

/**
 * Distinguish an already verified Auth release from a permitted upgrade.
 * @param target - Complete recipe with its optional independent Auth host.
 * @param release - Frozen verified publication.
 * @param observed - Fresh Auth host evidence, including immutable image references.
 * @returns True only when every Auth service already runs the candidate; mixed or newer versions are refused.
 */
export function authDeploymentCurrent(
    target: ReleaseDeploymentTarget,
    release: DeploymentRelease,
    observed: DeploymentObservation
): boolean {
    if (!target.auth || observed.targetHash !== deploymentDigest(target.auth))
        throw new Error("Auth deployment authority changed");
    const services = target.auth.services.map((service) => ({
        service,
        current: observed.containers[service.name],
        candidate: release.images.find((image) => image.app === service.app)?.reference,
    }));
    if (services.some(({ current }) => !current?.running || current.health !== "healthy"))
        throw new Error("Auth deployment is not healthy");
    if (
        services.every(
            ({ current, candidate }) => candidate && current!.image === candidate
        )
    )
        return true;
    const next = release.version.split(".").map(Number);
    const older = services.every(({ service, current }) => {
        const prefix = `ghcr.io/${release.repository.toLowerCase()}/${service.app}:`;
        if (!current!.image.startsWith(prefix)) return false;
        const version = /^(\d+)\.(\d+)\.(\d+)@sha256:[a-f0-9]{64}$/
            .exec(current!.image.slice(prefix.length))
            ?.slice(1)
            .map(Number);
        if (
            !version?.every((part) => Number.isSafeInteger(part)) ||
            !next.every((part) => Number.isSafeInteger(part))
        )
            return false;
        const difference = version.findIndex((part, index) => part !== next[index]);
        return difference !== -1 && version[difference]! < next[difference]!;
    });
    if (!older)
        throw new Error("Auth must run an older version or the exact approved release");
    return false;
}

/**
 * Register short, read-only deployment preparation on the existing job lanes.
 * @param options - Explicit recipes, release repository, existing SSH authorities and optional test boundaries.
 * @returns Preparation jobs; no target can be replaced through ordinary jobs.run.
 */
export function deploymentPreparationJobs(options: {
    targets: readonly ReleaseDeploymentTarget[];
    connections: readonly UpdateTarget[];
    repository: string | undefined;
    token?: string | undefined;
    host?: DeploymentHost;
    read?: typeof readHomelabRelease;
}): JobHandler[] {
    if (!options.repository) return [];
    return options.targets.map((target) => ({
        definition: {
            key: `homelab.prepare.${target.id}`,
            label: `Prepare release: ${target.label}`,
            description:
                "Check the published release and current deployment before confirmation.",
            capability: "updates:refresh",
            resourceClass: "network",
            resourceKeys: [
                ...new Set(
                    deploymentHosts(target).flatMap((entry) =>
                        updateResourceKeys(
                            options.connections.find(
                                (connection) => connection.id === entry.connection
                            )!
                        )
                    )
                ),
            ],
            timeoutMs: 60_000,
            attemptLimit: 1,
            retrySafe: true,
            intervalSeconds: null,
            validate: (input) => v.parse(v.strictObject({}), input),
        },
        execute: async (_input, context) => {
            const published = await (options.read ?? readHomelabRelease)(
                options.repository!,
                options.token,
                context.signal
            );
            const release = deploymentRelease(published, target);
            const connection = options.connections.find(
                (entry) => entry.id === target.connection
            )!;
            const expected = v.parse(
                deploymentObservationSchema,
                await (options.host ?? deploymentHost)(
                    connection,
                    { mode: "inspect", target, release },
                    context.signal
                )
            );
            if (expected.targetHash !== deploymentDigest(target))
                throw new Error("Deployment authority changed");
            const configuration = releaseDeploymentRevision(target, options.connections);
            const authExpected = target.auth
                ? v.parse(
                      deploymentObservationSchema,
                      await (options.host ?? deploymentHost)(
                          options.connections.find(
                              (entry) => entry.id === target.auth!.connection
                          )!,
                          {
                              mode: "inspect",
                              target: target.auth,
                              release,
                              allowCurrent: true,
                          },
                          context.signal
                      )
                  )
                : undefined;
            if (target.auth && authExpected?.targetHash !== deploymentDigest(target.auth))
                throw new Error("Auth deployment authority changed");
            if (authExpected) authDeploymentCurrent(target, release, authExpected);
            const value = {
                configuration,
                release,
                expected,
                ...(authExpected ? { authExpected } : {}),
            };
            if (
                !(await context.commit(async (transaction) => {
                    const [active] = await transaction<
                        { id: string }[]
                    >`SELECT id FROM release_deployments WHERE finished_at IS NULL`;
                    if (active)
                        throw new Error(
                            "Deployment started while preparation was running. Prepare again after it finishes."
                        );
                    await transaction`INSERT INTO operation_snapshots (key,value,captured_at) VALUES (${`homelab.prepare.${target.id}`}, ${JSON.stringify(value)}::text::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,captured_at=EXCLUDED.captured_at`;
                }, true))
            )
                throw new Error("Deployment preparation ownership changed");
        },
    }));
}

/**
 * Read recent preparation without sending host paths or command recipes to the browser.
 * @param client - Operation pool or serialized admission transaction.
 * @param target - Currently configured deployment recipe.
 * @param connections - Current scoped SSH authorities.
 * @returns A fingerprint and private frozen plan when preparation remains usable.
 */
export async function preparedDeployment(
    client: SQL | TransactionSQL,
    target: ReleaseDeploymentTarget,
    connections: readonly UpdateTarget[]
) {
    const [row] = await client<{ value: unknown; capturedAt: string; fresh: boolean }[]>`
        SELECT value, captured_at::text AS "capturedAt", captured_at > now() - interval '5 minutes' AS fresh
        FROM operation_snapshots WHERE key = ${`homelab.prepare.${target.id}`}`;
    const parsed = v.safeParse(deploymentPlanSchema, row?.value);
    const plan =
        parsed.success &&
        row?.fresh &&
        Boolean(target.auth) === Boolean(parsed.output.authExpected) &&
        parsed.output.configuration === releaseDeploymentRevision(target, connections)
            ? parsed.output
            : null;
    return {
        plan,
        revision: plan ? deploymentDigest({ plan, capturedAt: row!.capturedAt }) : null,
    };
}
