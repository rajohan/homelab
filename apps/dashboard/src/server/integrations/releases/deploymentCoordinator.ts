import type { SQL } from "bun";
import * as v from "valibot";

import { lockQueue } from "../../jobs/queue";
import { auditOperation } from "../../operations/audit";
import type { UpdateTarget } from "../updates/configuration";
import {
    releaseDeploymentRevision,
    type ReleaseDeploymentTarget,
} from "./deploymentConfiguration";
import { deploymentRelease } from "./deploymentPlans";
import { automaticDeploymentAllowed } from "./deploymentPolicies";
import {
    deploymentDigest,
    deploymentHost,
    deploymentObservationSchema,
    deploymentPlanSchema,
    deploymentProgressSchema,
    deploymentReceiptSchema,
    type DeploymentHost,
    type DeploymentReceipt,
    type DeploymentProgress,
} from "./deploymentProtocol";
import { readHomelabRelease } from "./read";

interface Claim {
    id: string;
    target: string;
    configuration: string;
    plan: unknown;
    receipt: unknown;
    state: string;
    expired: boolean;
    lease: string;
    policyVersion: number | null;
    windowEndsAt: Date | null;
}

/**
 * Advance one durable deployment without occupying any ordinary or reserved job lane.
 * @param options - Worker-owned database, fixed host recipes, bounded lifecycle and testable transport.
 * @returns Completion after one short state transition; the host independently owns actual replacement.
 */
export async function coordinateDeployment(options: {
    client: SQL;
    controller: string;
    signal: AbortSignal;
    targets: readonly ReleaseDeploymentTarget[];
    connections: readonly UpdateTarget[];
    repository: string | undefined;
    token?: string | undefined;
    host?: DeploymentHost;
    read?: typeof readHomelabRelease;
}): Promise<void> {
    const { client, controller } = options;
    const lease = crypto.randomUUID();
    const claim = await client.begin(async (transaction) => {
        await lockQueue(transaction);
        const [row] = await transaction<Claim[]>`
            UPDATE release_deployments SET controller=${controller}, lease_token=${lease},
                lease_expires_at=clock_timestamp()+interval '180 seconds'
            WHERE finished_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
            RETURNING id,target,configuration,plan,receipt,state,policy_version AS "policyVersion",window_ends_at AS "windowEndsAt",created_at<clock_timestamp()-interval '30 minutes' AS expired,lease_token AS lease`;
        return row;
    });
    if (!claim) return;
    const write = async (
        state: string,
        phase: string,
        message: string,
        finished: boolean,
        receipt?: DeploymentReceipt | DeploymentProgress
    ) =>
        client.begin(async (transaction) => {
            await lockQueue(transaction);
            const target = options.targets.find((entry) => entry.id === claim.target);
            const allowed =
                claim.policyVersion === null ||
                claim.state !== "waiting" ||
                (state !== "waiting" && state !== "submitting") ||
                (target !== undefined &&
                    claim.windowEndsAt !== null &&
                    (await automaticDeploymentAllowed(
                        transaction,
                        target,
                        options.connections,
                        claim.policyVersion,
                        claim.windowEndsAt
                    )));
            const nextState = allowed ? state : "cancelled";
            const nextPhase = allowed ? phase : "policy";
            const nextMessage = allowed
                ? message
                : "Automatic deployment cancelled before replacement because its policy or maintenance window changed.";
            const complete = finished || !allowed;
            const rows = await transaction<{ id: string }[]>`
                UPDATE release_deployments SET state=${nextState},phase=${nextPhase},message=${nextMessage},
                receipt=${JSON.stringify(receipt ?? claim.receipt ?? null)}::text::jsonb,updated_at=now(),
                finished_at=CASE WHEN ${complete} THEN now() ELSE NULL END
                WHERE id=${claim.id} AND lease_token=${lease} AND lease_expires_at>clock_timestamp() AND finished_at IS NULL
                RETURNING id`;
            if (rows.length > 0 && complete)
                await auditOperation(
                    transaction,
                    `worker:${controller}`,
                    `releases.${nextState}`,
                    claim.id,
                    nextMessage
                );
            if (rows.length > 0 && receipt) claim.receipt = receipt;
            return rows.length === 1 && allowed;
        });
    try {
        const target = options.targets.find((entry) => entry.id === claim.target);
        const mainConnection =
            target && options.connections.find((entry) => entry.id === target.connection);
        if (
            !target ||
            !mainConnection ||
            !options.repository ||
            claim.configuration !== releaseDeploymentRevision(target, options.connections)
        ) {
            await write(
                claim.state === "waiting" ? "failed" : "unknown",
                "configuration",
                "Deployment configuration changed. Restore the approved configuration to inspect an already submitted operation.",
                claim.state === "waiting"
            );
            return;
        }
        const plan = v.parse(deploymentPlanSchema, claim.plan);
        if (Boolean(target.auth) !== Boolean(plan.authExpected))
            throw new Error("Auth preparation is incomplete");
        let progress: DeploymentProgress | undefined;
        if (target.auth)
            progress =
                claim.state === "waiting"
                    ? { stage: "auth", submitted: false }
                    : v.parse(deploymentProgressSchema, claim.receipt);
        const hostTarget = progress?.stage === "auth" ? target.auth! : target;
        const expected = progress?.stage === "auth" ? plan.authExpected! : plan.expected;
        const connection = options.connections.find(
            (entry) => entry.id === hostTarget.connection
        )!;
        const authIntent = target.auth
            ? {
                  id: claim.id,
                  target: target.auth,
                  release: plan.release,
                  expected: plan.authExpected!,
              }
            : undefined;
        const authCompleted = (receipt: DeploymentReceipt | undefined) =>
            Boolean(
                receipt?.state === "succeeded" &&
                receipt.requestHash === deploymentDigest(authIntent) &&
                receipt.id === claim.id &&
                receipt.phase === "complete" &&
                receipt.migrationStarted &&
                receipt.version === plan.release.version &&
                receipt.revision === plan.release.revision &&
                target.auth!.services.every((service) => {
                    const observed = receipt.containers?.[service.name];
                    return (
                        observed?.running &&
                        observed.health === "healthy" &&
                        observed.image ===
                            plan.release.images.find((image) => image.app === service.app)
                                ?.reference
                    );
                })
            );
        if (progress?.stage === "main" && !authCompleted(progress.auth))
            throw new Error("Auth completion evidence is missing");
        const host = options.host ?? deploymentHost;
        const intent = {
            id: claim.id,
            target: hostTarget,
            release: plan.release,
            expected,
        };
        if (claim.state === "waiting") {
            if (
                claim.policyVersion !== null &&
                !(await write(
                    "waiting",
                    "checking",
                    "Checking automatic deployment policy.",
                    false
                ))
            )
                return;
            if (claim.expired) {
                await write(
                    "failed",
                    "expired",
                    "Deployment confirmation expired before replacement started. Prepare the release again.",
                    true
                );
                return;
            }
            const [busy] = await client<
                {
                    jobs: boolean;
                    workers: boolean;
                    legacy: boolean;
                    mira: boolean;
                    browsers: boolean;
                    unexpectedMira: boolean;
                }[]
            >`
                SELECT EXISTS(SELECT 1 FROM job_runs WHERE state='running') AS jobs,
                EXISTS(SELECT 1 FROM workers WHERE heartbeat_at>clock_timestamp()-interval '30 seconds' AND deployment_drained_for IS DISTINCT FROM ${claim.id}::uuid) AS workers,
                EXISTS(SELECT 1 FROM workers WHERE heartbeat_at>clock_timestamp()-interval '30 seconds' AND deployment_protocol<>1) AS legacy,
                NOT EXISTS(SELECT 1 FROM mira_runtime_status WHERE deployment_drained_for=${claim.id} AND heartbeat_at>clock_timestamp()-interval '15 seconds') AS mira,
                EXISTS(SELECT 1 FROM mira_browser_processes WHERE state<>'removed') AS browsers,
                EXISTS(SELECT 1 FROM mira_runtime_status WHERE heartbeat_at>clock_timestamp()-interval '30 seconds') AS "unexpectedMira"`;
            if (!busy) throw new Error("Deployment admission unavailable");
            if (busy.legacy || (!target.mira && busy.unexpectedMira)) {
                await write(
                    "failed",
                    "incompatible",
                    "The running services do not support this deployment recipe. Complete the initial installation before using self-update.",
                    true
                );
                return;
            }
            if (
                busy.jobs ||
                busy.workers ||
                (target.mira && busy.mira) ||
                busy.browsers
            ) {
                await write(
                    "waiting",
                    "draining",
                    "Waiting for active work and browser cleanup. Queued work is preserved.",
                    false
                );
                return;
            }
            const published = await (options.read ?? readHomelabRelease)(
                options.repository,
                options.token,
                AbortSignal.any([options.signal, AbortSignal.timeout(45_000)])
            );
            if (
                deploymentDigest(deploymentRelease(published, target)) !==
                deploymentDigest(plan.release)
            ) {
                await write(
                    "failed",
                    "publication",
                    "The published release changed. Prepare and confirm the current release.",
                    true
                );
                return;
            }
        }
        if (
            claim.state === "waiting" ||
            (progress?.stage === "main" && !progress.submitted)
        ) {
            if (progress?.stage === "main") {
                // Auth must still match the successful receipt before restarting the dashboard host.
                const current = v.parse(
                    deploymentObservationSchema,
                    await host(
                        options.connections.find(
                            (entry) => entry.id === target.auth!.connection
                        )!,
                        {
                            mode: "inspect",
                            target: target.auth!,
                            release: plan.release,
                            allowCurrent: true,
                        },
                        AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
                    )
                );
                if (
                    current.targetHash !== deploymentDigest(target.auth) ||
                    progress.auth?.state !== "succeeded" ||
                    deploymentDigest(current.containers) !==
                        deploymentDigest(progress.auth.containers)
                )
                    throw new Error("Auth changed after deployment");
            }
            // Persist each host boundary: losing SSH never repeats either installation.
            if (progress) progress.submitted = true;
            if (
                !(await write(
                    "submitting",
                    "accepted",
                    progress?.stage === "auth"
                        ? "Starting the Auth deployment."
                        : "Starting the dashboard, worker and Mira deployment.",
                    false,
                    progress
                ))
            )
                return;
            claim.state = "submitting";
            await host(
                connection,
                {
                    mode: "submit",
                    ...intent,
                    deadline: Math.floor(Date.now() / 1000) + 60,
                },
                AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
            );
        }
        const receipt = v.parse(
            deploymentReceiptSchema,
            await host(
                connection,
                { mode: "status", target: hostTarget, id: claim.id },
                AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
            )
        );
        if (
            receipt.id !== claim.id ||
            (receipt.state !== "absent" &&
                receipt.requestHash !== deploymentDigest(intent))
        )
            throw new Error("Deployment receipt does not match the approved operation");
        if (progress) progress[progress.stage] = receipt;
        const evidence = progress ?? receipt;
        if (receipt.state === "absent" || receipt.state === "unknown") {
            await write(
                "unknown",
                "recovery",
                "The host outcome is unknown. Work remains paused until the host journal and database are recovered.",
                false,
                evidence
            );
        } else if (receipt.state === "succeeded") {
            if (
                receipt.version !== plan.release.version ||
                receipt.revision !== plan.release.revision ||
                receipt.phase !== "complete" ||
                !receipt.migrationStarted ||
                !receipt.containers ||
                hostTarget.services.some((service) => {
                    const observed = receipt.containers?.[service.name];
                    return (
                        !observed?.running ||
                        observed.health !== "healthy" ||
                        observed.image !==
                            plan.release.images.find((image) => image.app === service.app)
                                ?.reference
                    );
                })
            )
                throw new Error("Deployment completion evidence is incomplete");
            if (progress?.stage === "auth") {
                await write(
                    "running",
                    "auth_complete",
                    "Auth is updated and verified. Preparing the dashboard, worker and Mira deployment.",
                    false,
                    { ...progress, stage: "main", submitted: false }
                );
                return;
            }
            await write(
                "succeeded",
                "complete",
                "Release deployed and all configured services verified.",
                true,
                evidence
            );
        } else if (receipt.state === "failed") {
            const recovered =
                receipt.recovered === true &&
                (!receipt.migrationStarted || receipt.code === "operator_recovered");
            const recoveredMessage =
                progress?.stage === "main"
                    ? "Auth was updated, but deployment on the dashboard host failed. Its previous services are verified and queued work can continue."
                    : "Deployment failed. The previous deployment is verified and queued work can continue.";
            await write(
                "failed",
                "failed",
                recovered
                    ? recoveredMessage
                    : "Deployment failed. Work remains paused; inspect the host journal and database backup before recovery.",
                recovered,
                evidence
            );
        } else {
            await write(
                "running",
                receipt.phase,
                progress?.stage === "auth"
                    ? "Auth is deploying the confirmed release."
                    : "The dashboard host is deploying the confirmed release. This page will reconnect after restart.",
                false,
                evidence
            );
        }
    } catch {
        if (!options.signal.aborted)
            await write(
                claim.state === "waiting" ? "waiting" : "unknown",
                "inspection",
                "Deployment status could not be verified. The coordinator will inspect it again without repeating the installation.",
                false
            );
    } finally {
        await client`UPDATE release_deployments SET controller=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=${claim.id} AND lease_token=${lease}`;
    }
}
