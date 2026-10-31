import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import type { UpdateTarget } from "../updates/configuration";
import { updateResourceKeys } from "../updates/configuration";
import {
    releaseDeploymentRevision,
    type ReleaseDeploymentTarget,
} from "./deploymentConfiguration";
import {
    deploymentDigest,
    deploymentHost,
    deploymentObservationSchema,
    deploymentPlanSchema,
    type DeploymentHost,
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
    if (!release.verified || (target.browserConfigFile && !release.browser))
        throw new Error("A complete verified release is required");
    const images = [
        ...release.images,
        ...(target.browserConfigFile ? release.browser!.images : []),
    ];
    if (
        target.services.some(
            (service) => !images.some((image) => image.app === service.app)
        )
    )
        throw new Error("Required release images are unavailable");
    return {
        repository: release.repository,
        version: release.version,
        revision: release.revision,
        images,
    };
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
            resourceKeys: updateResourceKeys(
                options.connections.find((entry) => entry.id === target.connection)!
            ),
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
            const value = { configuration, release, expected };
            if (
                !(await context.commit(async (transaction) => {
                    await transaction`INSERT INTO operation_snapshots (key,value,captured_at) VALUES (${`homelab.prepare.${target.id}`}, ${JSON.stringify(value)}::text::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,captured_at=EXCLUDED.captured_at`;
                }))
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
        parsed.output.configuration === releaseDeploymentRevision(target, connections)
            ? parsed.output
            : null;
    return {
        plan,
        revision: plan ? deploymentDigest({ plan, capturedAt: row!.capturedAt }) : null,
    };
}
