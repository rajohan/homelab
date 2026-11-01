import type { DeploymentPolicySummary } from "@homelab/contracts/deployment";
import type { SQL } from "bun";
import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import type { UpdateTarget } from "../updates/configuration";
import { updateResourceKeys } from "../updates/configuration";
import { admitDeployment } from "./deploymentAdmission";
import {
    deploymentHosts,
    releaseDeploymentRevision,
    type ReleaseDeploymentTarget,
} from "./deploymentConfiguration";
import { deploymentRelease } from "./deploymentPlans";
import { readDeploymentPolicy, automaticDeploymentAllowed } from "./deploymentPolicies";
import {
    deploymentDigest,
    deploymentHost,
    deploymentObservationSchema,
    type DeploymentHost,
    type DeploymentPlan,
} from "./deploymentProtocol";
import { deploymentWindowEnd } from "./deploymentWindow";
import { readHomelabRelease } from "./read";

/**
 * Require a strictly newer stable patch/minor and identical qualified migration programs.
 * @param policy - Current explicitly approved update scope.
 * @param target - Complete services included in the host recipe.
 * @param plan - Verified publication and fresh observations of every installed service.
 * @returns Whether this candidate can use automatic admission; missing evidence stays manual.
 */
export function automaticReleaseEligible(
    policy: DeploymentPolicySummary,
    target: ReleaseDeploymentTarget,
    plan: DeploymentPlan
): boolean {
    const next = /^(\d+)\.(\d+)\.(\d+)$/.exec(plan.release.version)?.slice(1).map(Number);
    if (
        policy.mode === "manual" ||
        policy.paused ||
        policy.configurationChanged ||
        !next?.every((part) => Number.isSafeInteger(part)) ||
        !plan.release.dashboardSchema ||
        (target.auth !== undefined && (!plan.release.authSchema || !plan.authExpected))
    )
        return false;
    return deploymentHosts(target).every((host) =>
        host.services.every((service) => {
            const observed = (host === target ? plan.expected : plan.authExpected)
                ?.containers[service.name];
            if (!observed) return false;
            const prefix = `ghcr.io/${plan.release.repository.toLowerCase()}/${service.app}:`;
            if (!observed.image.startsWith(prefix)) return false;
            const before = /^(\d+)\.(\d+)\.(\d+)@sha256:[a-f0-9]{64}$/
                .exec(observed.image.slice(prefix.length))
                ?.slice(1)
                .map(Number);
            if (
                !before?.every((part) => Number.isSafeInteger(part)) ||
                before[0] !== next[0] ||
                before[1]! > next[1]! ||
                (before[1] === next[1] && before[2]! >= next[2]!)
            )
                return false;
            if (policy.mode === "patch" && before[1] !== next[1]) return false;
            return (
                service.app === "mira-browser-proxy" ||
                (service.app === "auth"
                    ? observed.authSchema === plan.release.authSchema
                    : observed.dashboardSchema === plan.release.dashboardSchema)
            );
        })
    );
}
/**
 * Register bounded automatic deployment checks on the existing network job lane.
 * @param options - Database, qualified host recipes and replaceable read-only transports.
 * @returns A scheduled check only when deployment is configured; policies default to manual.
 */
export function automaticDeploymentJobs(options: {
    client: SQL;
    targets: readonly ReleaseDeploymentTarget[];
    connections: readonly UpdateTarget[];
    repository: string | undefined;
    token?: string | undefined;
    host?: DeploymentHost;
    read?: typeof readHomelabRelease;
}): JobHandler[] {
    if (!options.repository || options.targets.length === 0) return [];
    return [
        {
            definition: {
                key: "homelab.automatic",
                label: "Check automatic Homelab deployment",
                description:
                    "Deploy qualified stable releases only under an enabled policy and within its maintenance window.",
                capability: "updates:configure",
                resourceClass: "network",
                resourceKeys: [
                    "homelab:deployment-policy",
                    ...new Set(
                        options.targets
                            .flatMap(deploymentHosts)
                            .flatMap((target) =>
                                updateResourceKeys(
                                    options.connections.find(
                                        (connection) =>
                                            connection.id === target.connection
                                    )!
                                )
                            )
                    ),
                ],
                timeoutMs: 300_000,
                attemptLimit: 1,
                retrySafe: false,
                intervalSeconds: 300,
                validate: (input) => v.parse(v.strictObject({}), input),
            },
            execute: async (_input, context) => {
                let published: Awaited<ReturnType<typeof readHomelabRelease>> | undefined;
                for (const target of options.targets) {
                    context.signal.throwIfAborted();
                    const policy = await readDeploymentPolicy(
                        options.client,
                        target,
                        options.connections
                    );
                    const windowEndsAt = deploymentWindowEnd(policy, Date.now());
                    if (
                        policy.mode === "manual" ||
                        policy.paused ||
                        policy.configurationChanged ||
                        windowEndsAt === null
                    )
                        continue;
                    const [active] = await options.client<
                        { id: string }[]
                    >`SELECT id FROM release_deployments WHERE finished_at IS NULL`;
                    if (active) return;
                    published ??= await (options.read ?? readHomelabRelease)(
                        options.repository!,
                        options.token,
                        context.signal
                    );
                    // An in-progress or legacy publication is not an actionable job failure.
                    const available = [
                        ...published.images,
                        ...(target.browserConfigFile
                            ? (published.browser?.images ?? [])
                            : []),
                        ...(target.localCodeConfigFile
                            ? (published.code?.images ?? [])
                            : []),
                    ];
                    if (
                        !published.verified ||
                        !published.dashboardSchema ||
                        (target.auth !== undefined && !published.authSchema) ||
                        (target.browserConfigFile && !published.browser) ||
                        (target.localCodeConfigFile && !published.code) ||
                        deploymentHosts(target)
                            .flatMap((entry) => entry.services)
                            .some(
                                (service) =>
                                    !available.some((image) => image.app === service.app)
                            )
                    )
                        continue;
                    const release = deploymentRelease(published, target);
                    const key = `automatic-deployment:${target.id}:${release.revision}:${windowEndsAt}`;
                    const [attempted] = await options.client<
                        { id: string }[]
                    >`SELECT id FROM release_deployments WHERE request_key=${key} OR (target=${target.id} AND policy_version IS NOT NULL AND state<>'cancelled' AND plan->'release'->>'revision'=${release.revision}) LIMIT 1`;
                    if (attempted) continue;
                    const connection = options.connections.find(
                        (entry) => entry.id === target.connection
                    )!;
                    const expected = v.parse(
                        deploymentObservationSchema,
                        await (options.host ?? deploymentHost)(
                            connection,
                            { mode: "inspect", target, release, allowCurrent: true },
                            context.signal
                        )
                    );
                    if (expected.targetHash !== deploymentDigest(target))
                        throw new Error("Deployment authority changed");
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
                    if (
                        target.auth &&
                        authExpected?.targetHash !== deploymentDigest(target.auth)
                    )
                        throw new Error("Auth deployment authority changed");
                    const plan = {
                        configuration: releaseDeploymentRevision(
                            target,
                            options.connections
                        ),
                        release,
                        expected,
                        ...(authExpected ? { authExpected } : {}),
                    };
                    if (!automaticReleaseEligible(policy, target, plan)) continue;
                    let admitted = false;
                    if (
                        !(await context.commit(async (query) => {
                            if (
                                !(await automaticDeploymentAllowed(
                                    query,
                                    target,
                                    options.connections,
                                    policy.version,
                                    new Date(windowEndsAt)
                                ))
                            )
                                return;
                            const [occupied] = await query<
                                { id: string }[]
                            >`SELECT id FROM release_deployments WHERE finished_at IS NULL OR request_key=${key} OR (target=${target.id} AND policy_version IS NOT NULL AND state<>'cancelled' AND plan->'release'->>'revision'=${release.revision}) LIMIT 1`;
                            if (occupied) return;
                            await admitDeployment(query, {
                                target: target.id,
                                actor: "system:automatic-deployment",
                                key,
                                revision: deploymentDigest(plan),
                                plan,
                                automatic: { version: policy.version, windowEndsAt },
                            });
                            admitted = true;
                        }, true))
                    )
                        throw new Error("Automatic deployment check ownership changed");
                    if (admitted) return;
                }
            },
        },
    ];
}
